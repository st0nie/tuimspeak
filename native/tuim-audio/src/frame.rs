//! stdio framing shared by both directions:
//!
//! ```text
//! [type: u8][len: u32 LE][payload: len bytes]
//! ```
//!
//! type 0x01 = PCM, type 0x02 = UTF-8 JSON control message, type 0x03 = effect PCM.

use std::io::{self, Read, Write};

pub const TYPE_PCM: u8 = 0x01;
pub const TYPE_JSON: u8 = 0x02;
pub const TYPE_EFFECT: u8 = 0x03;

/// Upper bound for one frame, so a corrupt length can't make us allocate gigabytes.
pub const MAX_PAYLOAD: usize = 1 << 20;

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub payload: Vec<u8>,
}

/// Reads one frame. `Ok(None)` means a clean EOF between frames.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut header = [0u8; 5];
    match reader.read_exact(&mut header[..1]) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    reader.read_exact(&mut header[1..])?;
    let len = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if len > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len} bytes"),
        ));
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    Ok(Some(Frame {
        kind: header[0],
        payload,
    }))
}

pub fn write_frame(writer: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    writer.write_all(&header)?;
    writer.write_all(payload)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, TYPE_PCM, &[1, 2, 3]).unwrap();
        write_frame(&mut buf, TYPE_JSON, b"{}").unwrap();
        let mut cursor = io::Cursor::new(buf);
        assert_eq!(
            read_frame(&mut cursor).unwrap(),
            Some(Frame {
                kind: TYPE_PCM,
                payload: vec![1, 2, 3]
            })
        );
        assert_eq!(
            read_frame(&mut cursor).unwrap(),
            Some(Frame {
                kind: TYPE_JSON,
                payload: b"{}".to_vec()
            })
        );
        assert_eq!(read_frame(&mut cursor).unwrap(), None);
    }

    #[test]
    fn truncated_frame_is_an_error() {
        let mut cursor = io::Cursor::new(vec![TYPE_PCM, 10, 0, 0, 0, 1, 2]);
        assert!(read_frame(&mut cursor).is_err());
    }

    #[test]
    fn oversized_length_is_rejected() {
        let len = (MAX_PAYLOAD as u32 + 1).to_le_bytes();
        let mut cursor = io::Cursor::new(vec![TYPE_PCM, len[0], len[1], len[2], len[3]]);
        assert!(read_frame(&mut cursor).is_err());
    }
}
