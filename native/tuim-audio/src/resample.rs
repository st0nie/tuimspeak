//! Streaming sample-rate conversion on planar (one Vec per channel) audio.
//! A pass-through when the rates already match, which is the common case on
//! Linux (48 kHz); many macOS devices run at 44.1 kHz.

use rubato::{FftFixedInOut, Resampler};

const CHUNK_FRAMES: usize = 480;

pub struct StreamResampler {
    inner: Option<FftFixedInOut<f32>>,
    pending: Vec<Vec<f32>>,
}

impl StreamResampler {
    pub fn new(from_rate: u32, to_rate: u32, channels: usize) -> anyhow::Result<Self> {
        let inner = if from_rate == to_rate {
            None
        } else {
            Some(FftFixedInOut::<f32>::new(
                from_rate as usize,
                to_rate as usize,
                CHUNK_FRAMES,
                channels,
            )?)
        };
        Ok(Self {
            inner,
            pending: vec![Vec::new(); channels],
        })
    }

    /// Feeds planar input; returns whatever planar output is ready. Input
    /// that doesn't fill a whole resampler chunk is kept for the next call.
    pub fn process(&mut self, input: &[Vec<f32>]) -> Vec<Vec<f32>> {
        let Some(resampler) = self.inner.as_mut() else {
            return input.to_vec();
        };
        for (pending, chunk) in self.pending.iter_mut().zip(input) {
            pending.extend_from_slice(chunk);
        }
        let mut out = vec![Vec::new(); self.pending.len()];
        loop {
            let need = resampler.input_frames_next();
            if self.pending.first().map_or(0, Vec::len) < need {
                break;
            }
            let chunk: Vec<Vec<f32>> = self
                .pending
                .iter_mut()
                .map(|ch| ch.drain(..need).collect())
                .collect();
            match resampler.process(&chunk, None) {
                Ok(result) => {
                    for (o, r) in out.iter_mut().zip(result) {
                        o.extend(r);
                    }
                }
                Err(_) => break,
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_at_equal_rates() {
        let mut r = StreamResampler::new(48_000, 48_000, 1).unwrap();
        assert_eq!(r.process(&[vec![0.5; 10]]), vec![vec![0.5; 10]]);
    }

    #[test]
    fn converts_length_by_rate_ratio() {
        let mut r = StreamResampler::new(44_100, 48_000, 2).unwrap();
        let mut total = 0;
        for _ in 0..100 {
            let out = r.process(&[vec![0.0; 441], vec![0.0; 441]]);
            assert_eq!(out[0].len(), out[1].len());
            total += out[0].len();
        }
        // 44100 input frames -> ~48000 output frames, minus what is still buffered.
        assert!((46_000..=48_000).contains(&total), "got {total}");
    }
}
