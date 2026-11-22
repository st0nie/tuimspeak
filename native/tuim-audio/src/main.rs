//! tuim-audio: microphone capture and speaker playback for tuimspeak.
//!
//! Talks to the main process over stdio using the framing in `frame.rs`:
//! - stdout: capture frames (s16le mono 48 kHz, 960 samples) and JSON events
//! - stdin:  playback frames (s16le stereo 48 kHz, 960 frames), JSON commands,
//!   and effect frames (notification sounds, s16le stereo 48 kHz, any length)
//! - stderr: logs
//!
//! It does no VAD, encoding or mixing: the main process gates voice and the
//! ts-connector mixes all speakers into the stream we play.

mod frame;
mod playback;
mod resample;

use std::io::{self, BufReader, BufWriter};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    Device, FromSample, Host, Sample, SampleFormat, SizedSample, Stream, StreamConfig,
    SupportedStreamConfig,
};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::Deserialize;
use serde_json::{json, Value};

use frame::{read_frame, write_frame, TYPE_EFFECT, TYPE_JSON, TYPE_PCM};
use playback::{BufferPolicy, PlaybackState};
use resample::StreamResampler;

const RATE: u32 = 48_000;
const FRAME_SAMPLES: usize = 960;
const PLAYBACK_FRAME_BYTES: usize = FRAME_SAMPLES * 2 * 2;
/// Sustained digital silence this long right after capture starts usually
/// means macOS denied microphone access to the terminal app.
const SILENT_INPUT_HINT_AFTER: Duration = Duration::from_secs(3);

enum Out {
    Pcm(Vec<u8>),
    Json(Value),
}

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Command {
    ListDevices,
    Open {
        #[serde(default)]
        input: Option<String>,
        #[serde(default)]
        output: Option<String>,
    },
    Capture {
        enabled: bool,
    },
}

#[derive(Default)]
struct Stats {
    underruns: AtomicU64,
    overflows: AtomicU64,
    buffered_samples: AtomicUsize,
    /// Output samples per millisecond (device rate * channels / 1000), for bufferedMs.
    samples_per_ms: AtomicUsize,
}

struct Output {
    _stream: Stream,
    producer: HeapProd<f32>,
    resampler: StreamResampler,
    /// Notification sounds, mixed on top of the voice stream (architecture §4.5).
    effects: HeapProd<f32>,
    effects_resampler: StreamResampler,
    channels: usize,
}

struct Capture {
    _stream: Stream,
    stop: Arc<AtomicBool>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

struct App {
    host: Host,
    tx: Sender<Out>,
    stats: Arc<Stats>,
    input_device: Option<String>,
    output: Option<Output>,
    capture: Option<Capture>,
}

fn main() {
    let (tx, rx) = mpsc::channel::<Out>();

    // One writer thread owns stdout, so capture frames and events never interleave mid-frame.
    let writer = thread::spawn(move || {
        let mut out = BufWriter::new(io::stdout().lock());
        for msg in rx {
            let result = match msg {
                Out::Pcm(bytes) => write_frame(&mut out, TYPE_PCM, &bytes),
                Out::Json(value) => write_frame(&mut out, TYPE_JSON, value.to_string().as_bytes()),
            };
            if result.is_err() {
                break; // main process went away
            }
        }
    });

    let stats = Arc::new(Stats::default());
    spawn_stats_reporter(tx.clone(), stats.clone());

    let host = cpal::default_host();
    eprintln!("tuim-audio: using host {}", host.id().name());
    let mut app = App {
        host,
        tx: tx.clone(),
        stats,
        input_device: None,
        output: None,
        capture: None,
    };

    let mut stdin = BufReader::new(io::stdin().lock());
    loop {
        match read_frame(&mut stdin) {
            Ok(Some(frame)) if frame.kind == TYPE_PCM => app.play(&frame.payload),
            Ok(Some(frame)) if frame.kind == TYPE_EFFECT => app.effect(&frame.payload),
            Ok(Some(frame)) if frame.kind == TYPE_JSON => {
                match serde_json::from_slice::<Command>(&frame.payload) {
                    Ok(cmd) => {
                        if let Err(e) = app.handle(cmd) {
                            app.send_error(format!("{e:#}"));
                        }
                    }
                    Err(e) => app.send_error(format!("invalid command: {e}")),
                }
            }
            Ok(Some(frame)) => app.send_error(format!("unknown frame type {}", frame.kind)),
            Ok(None) => break,
            Err(e) => {
                eprintln!("tuim-audio: stdin: {e}");
                break;
            }
        }
    }
    drop(app);
    drop(tx);
    let _ = writer.join();
}

fn spawn_stats_reporter(tx: Sender<Out>, stats: Arc<Stats>) {
    thread::spawn(move || {
        let mut last = (0, 0);
        loop {
            thread::sleep(Duration::from_secs(5));
            let now = (
                stats.underruns.load(Ordering::Relaxed),
                stats.overflows.load(Ordering::Relaxed),
            );
            if now == last {
                continue;
            }
            last = now;
            let per_ms = stats.samples_per_ms.load(Ordering::Relaxed).max(1);
            let event = json!({
                "event": "stats",
                "underruns": now.0,
                "overflows": now.1,
                "bufferedMs": stats.buffered_samples.load(Ordering::Relaxed) / per_ms,
            });
            if tx.send(Out::Json(event)).is_err() {
                return;
            }
        }
    });
}

fn device_id(device: &Device) -> String {
    device.id().map(|id| id.to_string()).unwrap_or_default()
}

fn device_name(device: &Device) -> String {
    device
        .description()
        .map(|d| d.to_string())
        .unwrap_or_else(|_| device_id(device))
}

fn describe(device: &Device, default_id: &str) -> Value {
    let id = device_id(device);
    json!({ "id": id, "name": device_name(device), "isDefault": id == default_id })
}

/// Prefers a 48 kHz config so no resampling is needed; otherwise the device default.
fn pick_config<I: Iterator<Item = cpal::SupportedStreamConfigRange>>(
    ranges: Result<I, cpal::Error>,
    default: Result<SupportedStreamConfig, cpal::Error>,
) -> anyhow::Result<SupportedStreamConfig> {
    let default = default.context("device has no default config")?;
    if default.sample_rate() == RATE {
        return Ok(default);
    }
    if let Ok(ranges) = ranges {
        let candidates: Vec<_> = ranges
            .filter_map(|r| r.try_with_sample_rate(RATE))
            .collect();
        if let Some(c) = candidates
            .iter()
            .find(|c| {
                c.sample_format() == default.sample_format() && c.channels() == default.channels()
            })
            .or_else(|| {
                candidates
                    .iter()
                    .find(|c| c.sample_format() == SampleFormat::F32)
            })
            .or(candidates.first())
        {
            return Ok(*c);
        }
    }
    Ok(default)
}

impl App {
    fn send(&self, value: Value) {
        let _ = self.tx.send(Out::Json(value));
    }

    fn send_error(&self, message: String) {
        eprintln!("tuim-audio: {message}");
        self.send(json!({ "event": "error", "message": message }));
    }

    fn find_device(&self, wanted: Option<&str>, input: bool) -> anyhow::Result<Device> {
        match wanted {
            None | Some("") | Some("default") => if input {
                self.host.default_input_device()
            } else {
                self.host.default_output_device()
            }
            .ok_or_else(|| {
                anyhow!(
                    "no default {} device",
                    if input { "input" } else { "output" }
                )
            }),
            Some(id) => {
                let parsed = id
                    .parse()
                    .map_err(|_| anyhow!("invalid device id {id:?}"))?;
                self.host
                    .device_by_id(&parsed)
                    .ok_or_else(|| anyhow!("device {id:?} not found"))
            }
        }
    }

    fn handle(&mut self, cmd: Command) -> anyhow::Result<()> {
        match cmd {
            Command::ListDevices => {
                let default_in = self
                    .host
                    .default_input_device()
                    .map(|d| device_id(&d))
                    .unwrap_or_default();
                let default_out = self
                    .host
                    .default_output_device()
                    .map(|d| device_id(&d))
                    .unwrap_or_default();
                let inputs: Vec<Value> = self
                    .host
                    .input_devices()?
                    .map(|d| describe(&d, &default_in))
                    .collect();
                let outputs: Vec<Value> = self
                    .host
                    .output_devices()?
                    .map(|d| describe(&d, &default_out))
                    .collect();
                self.send(json!({ "event": "devices", "host": self.host.id().name(), "inputs": inputs, "outputs": outputs }));
            }
            Command::Open { input, output } => {
                self.input_device = input;
                let restart_capture = self.capture.is_some();
                self.capture = None;
                self.output = None;
                let device = self.find_device(output.as_deref(), false)?;
                self.output = Some(self.open_output(&device)?);
                if restart_capture {
                    self.start_capture()?;
                }
            }
            Command::Capture { enabled } => {
                if enabled {
                    if self.capture.is_none() {
                        self.start_capture()?;
                    }
                } else if self.capture.take().is_some() {
                    self.send(json!({ "event": "captureStopped" }));
                }
            }
        }
        Ok(())
    }

    fn open_output(&self, device: &Device) -> anyhow::Result<Output> {
        let supported = pick_config(
            device.supported_output_configs(),
            device.default_output_config(),
        )?;
        let config: StreamConfig = supported.config();
        let channels = config.channels as usize;
        let samples_per_ms = config.sample_rate as usize * channels / 1000;
        self.stats
            .samples_per_ms
            .store(samples_per_ms, Ordering::Relaxed);
        let (producer, consumer) = HeapRb::<f32>::new(samples_per_ms * 1000).split();
        let (effects, effects_consumer) = HeapRb::<f32>::new(samples_per_ms * 2000).split();
        let policy = BufferPolicy {
            prebuffer: samples_per_ms * 40,
            high_water: samples_per_ms * 200,
            target: samples_per_ms * 60,
        };
        let stream = match supported.sample_format() {
            SampleFormat::F32 => {
                self.build_output::<f32>(device, config, consumer, effects_consumer, policy)
            }
            SampleFormat::I16 => {
                self.build_output::<i16>(device, config, consumer, effects_consumer, policy)
            }
            SampleFormat::I32 => {
                self.build_output::<i32>(device, config, consumer, effects_consumer, policy)
            }
            SampleFormat::U16 => {
                self.build_output::<u16>(device, config, consumer, effects_consumer, policy)
            }
            other => Err(anyhow!("unsupported output sample format {other:?}")),
        }?;
        stream.play()?;
        self.send(json!({
            "event": "outputOpened",
            "name": device_name(device),
            "sampleRate": config.sample_rate,
            "channels": channels,
        }));
        Ok(Output {
            _stream: stream,
            producer,
            resampler: StreamResampler::new(RATE, config.sample_rate, 2)?,
            effects,
            effects_resampler: StreamResampler::new(RATE, config.sample_rate, 2)?,
            channels,
        })
    }

    fn build_output<T: SizedSample + FromSample<f32>>(
        &self,
        device: &Device,
        config: StreamConfig,
        mut consumer: HeapCons<f32>,
        mut effects: HeapCons<f32>,
        policy: BufferPolicy,
    ) -> anyhow::Result<Stream> {
        let stats = self.stats.clone();
        let tx = self.tx.clone();
        let mut state = PlaybackState::default();
        let mut scratch: Vec<f32> = Vec::new();
        let mut fx: Vec<f32> = Vec::new();
        let stream = device.build_output_stream(
            config,
            move |data: &mut [T], _| {
                scratch.resize(data.len(), 0.0);
                let result = state.fill(&mut consumer, &mut scratch, &policy);
                if result.underrun {
                    stats.underruns.fetch_add(1, Ordering::Relaxed);
                }
                if result.skipped > 0 {
                    stats.overflows.fetch_add(1, Ordering::Relaxed);
                }
                stats
                    .buffered_samples
                    .store(consumer.occupied_len(), Ordering::Relaxed);
                fx.resize(data.len(), 0.0);
                let n = effects.pop_slice(&mut fx);
                fx[n..].fill(0.0);
                for ((out, voice), effect) in data.iter_mut().zip(&scratch).zip(&fx) {
                    *out = T::from_sample((voice + effect).clamp(-1.0, 1.0));
                }
            },
            move |err| {
                let _ = tx.send(Out::Json(
                    json!({ "event": "error", "message": format!("output stream: {err}") }),
                ));
            },
            None,
        )?;
        Ok(stream)
    }

    /// One playback frame from the connector: s16le stereo 48 kHz.
    fn play(&mut self, payload: &[u8]) {
        let Some(output) = self.output.as_mut() else {
            return;
        };
        if payload.len() != PLAYBACK_FRAME_BYTES {
            return;
        }
        let samples = to_device(&mut output.resampler, output.channels, payload);
        if output.producer.push_slice(&samples) < samples.len() {
            self.stats.overflows.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// A notification sound: s16le stereo 48 kHz, any whole number of frames.
    fn effect(&mut self, payload: &[u8]) {
        let Some(output) = self.output.as_mut() else {
            return;
        };
        if !payload.len().is_multiple_of(4) {
            return;
        }
        let samples = to_device(&mut output.effects_resampler, output.channels, payload);
        // A sound that does not fit is cut short rather than delayed.
        output.effects.push_slice(&samples);
    }

    fn start_capture(&mut self) -> anyhow::Result<()> {
        let device = self.find_device(self.input_device.as_deref(), true)?;
        let supported = pick_config(
            device.supported_input_configs(),
            device.default_input_config(),
        )?;
        let config: StreamConfig = supported.config();
        let channels = config.channels as usize;
        let (producer, consumer) = HeapRb::<f32>::new(config.sample_rate as usize).split();
        let stream = match supported.sample_format() {
            SampleFormat::F32 => self.build_input::<f32>(&device, config, producer),
            SampleFormat::I16 => self.build_input::<i16>(&device, config, producer),
            SampleFormat::I32 => self.build_input::<i32>(&device, config, producer),
            SampleFormat::U16 => self.build_input::<u16>(&device, config, producer),
            other => Err(anyhow!("unsupported input sample format {other:?}")),
        }?;
        stream.play()?;
        let stop = Arc::new(AtomicBool::new(false));
        spawn_capture_framer(
            consumer,
            StreamResampler::new(config.sample_rate, RATE, 1)?,
            self.tx.clone(),
            stop.clone(),
        );
        self.send(json!({
            "event": "captureStarted",
            "name": device_name(&device),
            "sampleRate": config.sample_rate,
            "channels": channels,
        }));
        self.capture = Some(Capture {
            _stream: stream,
            stop,
        });
        Ok(())
    }

    fn build_input<T: SizedSample>(
        &self,
        device: &Device,
        config: StreamConfig,
        mut producer: HeapProd<f32>,
    ) -> anyhow::Result<Stream>
    where
        f32: FromSample<T>,
    {
        let channels = config.channels as usize;
        let tx = self.tx.clone();
        let stream = device.build_input_stream(
            config,
            move |data: &[T], _| {
                // Downmix to mono; the framer thread resamples and cuts 20 ms frames.
                for frame in data.chunks_exact(channels) {
                    let sum: f32 = frame.iter().map(|s| f32::from_sample(*s)).sum();
                    let _ = producer.try_push(sum / channels as f32);
                }
            },
            move |err| {
                let _ = tx.send(Out::Json(
                    json!({ "event": "error", "message": format!("input stream: {err}") }),
                ));
            },
            None,
        )?;
        Ok(stream)
    }
}

/// Pulls captured mono samples, resamples to 48 kHz and emits 960-sample s16le frames.
fn spawn_capture_framer(
    mut consumer: HeapCons<f32>,
    mut resampler: StreamResampler,
    tx: Sender<Out>,
    stop: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let started = Instant::now();
        let mut heard_signal = false;
        let mut hinted = false;
        let mut chunk = vec![0.0f32; 4096];
        let mut pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 4);
        while !stop.load(Ordering::Relaxed) {
            let n = consumer.pop_slice(&mut chunk);
            if n == 0 {
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            heard_signal |= chunk[..n].iter().any(|s| *s != 0.0);
            if !heard_signal && !hinted && started.elapsed() > SILENT_INPUT_HINT_AFTER {
                hinted = true;
                let _ = tx.send(Out::Json(json!({ "event": "silentInput" })));
            }
            let out = resampler.process(&[chunk[..n].to_vec()]);
            pending.extend_from_slice(&out[0]);
            while pending.len() >= FRAME_SAMPLES {
                let mut bytes = Vec::with_capacity(FRAME_SAMPLES * 2);
                for s in pending.drain(..FRAME_SAMPLES) {
                    bytes.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
                }
                if tx.send(Out::Pcm(bytes)).is_err() {
                    return;
                }
            }
        }
    });
}

/// s16le stereo 48 kHz bytes -> interleaved f32 at the device's rate and channel count.
fn to_device(resampler: &mut StreamResampler, channels: usize, payload: &[u8]) -> Vec<f32> {
    let frames_in = payload.len() / 4;
    let mut planar = vec![Vec::with_capacity(frames_in), Vec::with_capacity(frames_in)];
    for (i, pair) in payload.as_chunks::<2>().0.iter().enumerate() {
        planar[i % 2].push(i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0);
    }
    let resampled = resampler.process(&planar);
    let frames = resampled[0].len();
    let mut interleaved = Vec::with_capacity(frames * channels);
    for f in 0..frames {
        let (l, r) = (resampled[0][f], resampled[1][f]);
        match channels {
            1 => interleaved.push((l + r) * 0.5),
            n => {
                interleaved.push(l);
                interleaved.push(r);
                interleaved.extend(std::iter::repeat_n(0.0, n - 2));
            }
        }
    }
    interleaved
}
