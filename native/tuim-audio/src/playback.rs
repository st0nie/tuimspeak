//! Playback jitter buffer policy, run inside the output callback.
//!
//! The connector only sends audio while someone talks, and its 20 ms ticks
//! don't run on the sound card's clock. So the buffer:
//! - waits for a small pre-buffer before starting a burst (no crackle when
//!   the first frames arrive with scheduling jitter),
//! - outputs silence when it runs dry and re-primes,
//! - skips ahead when it holds too much, so clock drift can't grow latency
//!   without bound.

use ringbuf::traits::{Consumer, Observer};

pub struct BufferPolicy {
    /// Samples (interleaved) to collect before a burst starts playing.
    pub prebuffer: usize,
    /// Above this many buffered samples, skip ahead to `target`.
    pub high_water: usize,
    pub target: usize,
}

#[derive(Default)]
pub struct PlaybackState {
    primed: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct FillResult {
    /// Ran dry in the middle of a burst.
    pub underrun: bool,
    /// Samples dropped to bring latency back down.
    pub skipped: usize,
}

impl PlaybackState {
    pub fn fill<C: Consumer<Item = f32> + Observer>(
        &mut self,
        consumer: &mut C,
        out: &mut [f32],
        policy: &BufferPolicy,
    ) -> FillResult {
        let mut result = FillResult::default();
        let mut available = consumer.occupied_len();
        if available > policy.high_water {
            let skip = available - policy.target;
            result.skipped = consumer.skip(skip);
            available -= result.skipped;
        }
        if !self.primed {
            if available < policy.prebuffer {
                out.fill(0.0);
                return result;
            }
            self.primed = true;
        }
        let read = consumer.pop_slice(out);
        if read < out.len() {
            out[read..].fill(0.0);
            // Partially filled means the burst was still going; an exactly
            // empty buffer is just the end of someone's sentence.
            result.underrun = read > 0;
            self.primed = false;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::{
        traits::{Producer, Split},
        HeapRb,
    };

    const POLICY: BufferPolicy = BufferPolicy {
        prebuffer: 4,
        high_water: 20,
        target: 8,
    };

    #[test]
    fn waits_for_prebuffer_then_plays() {
        let (mut prod, mut cons) = HeapRb::<f32>::new(64).split();
        let mut state = PlaybackState::default();
        let mut out = [9.0f32; 2];
        prod.push_slice(&[1.0, 1.0]);
        state.fill(&mut cons, &mut out, &POLICY);
        assert_eq!(out, [0.0, 0.0], "not primed yet");
        prod.push_slice(&[2.0, 3.0]);
        state.fill(&mut cons, &mut out, &POLICY);
        assert_eq!(out, [1.0, 1.0]);
    }

    #[test]
    fn skips_ahead_when_too_full() {
        let (mut prod, mut cons) = HeapRb::<f32>::new(64).split();
        let mut state = PlaybackState::default();
        let data: Vec<f32> = (0..30).map(|i| i as f32).collect();
        prod.push_slice(&data);
        let mut out = [0.0f32; 2];
        let r = state.fill(&mut cons, &mut out, &POLICY);
        assert_eq!(r.skipped, 22);
        assert_eq!(out, [22.0, 23.0]);
    }

    #[test]
    fn partial_read_is_an_underrun_and_reprimes() {
        let (mut prod, mut cons) = HeapRb::<f32>::new(64).split();
        let mut state = PlaybackState::default();
        prod.push_slice(&[1.0; 5]);
        let mut out = [0.0f32; 4];
        assert!(!state.fill(&mut cons, &mut out, &POLICY).underrun);
        let r = state.fill(&mut cons, &mut out, &POLICY);
        assert!(r.underrun);
        assert_eq!(out, [1.0, 0.0, 0.0, 0.0]);
        prod.push_slice(&[1.0; 2]);
        state.fill(&mut cons, &mut out, &POLICY);
        assert_eq!(out, [0.0; 4], "re-priming after running dry");
    }
}
