//! Opus audio from a second scrcpy-server (`video=false`), fanned out to
//! `/ws/devices/{serial}/audio`.
//!
//! The video server stays `raw_stream=true` with no frame headers. Audio uses
//! its own socket so those headers never land on the H264 parser.
//! After the dummy byte the audio socket is: 4-byte codec id, then 12-byte
//! packet headers (`pts+flags` u64 BE, size u32 BE) and the payload.
//! Config packets (flag bit 63) are the OpusHead description.

use phonecontrol_protocol::{AudioStatusFrame, StreamState};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{broadcast, Mutex};
use tracing::warn;

pub const OPUS_CODEC_ID: u32 = 0x6f70_7573;
const MAX_PACKET: u32 = 1_000_000;

#[derive(Clone)]
pub enum AudioFrame {
    Status(AudioStatusFrame),
    /// 8-byte big-endian PTS (microseconds) followed by one Opus packet.
    Packet(Vec<u8>),
}

struct AudioChannel {
    tx: broadcast::Sender<AudioFrame>,
    last_status: Mutex<Option<AudioStatusFrame>>,
}

pub struct AudioHub {
    channels: Mutex<HashMap<String, Arc<AudioChannel>>>,
}

impl AudioHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            channels: Mutex::new(HashMap::new()),
        })
    }

    async fn channel(&self, serial: &str) -> Arc<AudioChannel> {
        let mut guard = self.channels.lock().await;
        if let Some(ch) = guard.get(serial) {
            return ch.clone();
        }
        let (tx, _) = broadcast::channel(32);
        let ch = Arc::new(AudioChannel {
            tx,
            last_status: Mutex::new(None),
        });
        guard.insert(serial.to_string(), ch.clone());
        ch
    }

    pub async fn subscribe(
        &self,
        serial: &str,
    ) -> (broadcast::Receiver<AudioFrame>, Option<AudioStatusFrame>) {
        let ch = self.channel(serial).await;
        let status = ch.last_status.lock().await.clone();
        (ch.tx.subscribe(), status)
    }

    pub async fn publish_status(&self, frame: AudioStatusFrame) {
        let ch = self.channel(&frame.serial).await;
        *ch.last_status.lock().await = Some(frame.clone());
        let _ = ch.tx.send(AudioFrame::Status(frame));
    }

    pub async fn publish_packet(&self, serial: &str, packet: Vec<u8>) {
        let ch = self.channel(serial).await;
        let _ = ch.tx.send(AudioFrame::Packet(packet));
    }

    pub async fn last_status(&self, serial: &str) -> Option<AudioStatusFrame> {
        let ch = {
            let guard = self.channels.lock().await;
            guard.get(serial).cloned()
        };
        let Some(ch) = ch else {
            return None;
        };
        let status = ch.last_status.lock().await.clone();
        status
    }
}

pub fn encode_opus_packet(pts_us: u64, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + data.len());
    out.extend_from_slice(&pts_us.to_be_bytes());
    out.extend_from_slice(data);
    out
}

/// Split one scrcpy audio packet header.
pub fn parse_packet_header(header: &[u8; 12]) -> (bool, u64, u32) {
    let pts_flags = u64::from_be_bytes(header[0..8].try_into().unwrap());
    let config = pts_flags & (1 << 63) != 0;
    let pts = pts_flags & ((1 << 62) - 1);
    let len = u32::from_be_bytes(header[8..12].try_into().unwrap());
    (config, pts, len)
}

pub fn b64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = (u32::from(data[i]) << 16) | (u32::from(data[i + 1]) << 8) | u32::from(data[i + 2]);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push(T[(n & 63) as usize] as char);
        i += 3;
    }
    let rest = data.len() - i;
    if rest == 1 {
        let n = u32::from(data[i]) << 16;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let n = (u32::from(data[i]) << 16) | (u32::from(data[i + 1]) << 8);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

pub fn spawn_opus_pump<R>(hub: Arc<AudioHub>, serial: String, reader: R)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(e) = run_opus_pump(hub.clone(), &serial, reader).await {
            warn!(%serial, error = %e, "opus audio pump ended");
            hub.publish_status(AudioStatusFrame {
                serial,
                stream: StreamState::Error,
                note: e,
                codec: "opus".into(),
                sample_rate: 48_000,
                channels: 2,
                framing: "opus-pts".into(),
                description: None,
            })
            .await;
        }
    });
}

pub async fn run_opus_pump<R>(hub: Arc<AudioHub>, serial: &str, mut reader: R) -> Result<(), String>
where
    R: AsyncRead + Unpin,
{
    let mut codec = [0u8; 4];
    reader
        .read_exact(&mut codec)
        .await
        .map_err(|e| format!("audio codec id: {e}"))?;
    let codec_id = u32::from_be_bytes(codec);
    if codec_id != OPUS_CODEC_ID {
        return Err(format!("audio codec is not opus ({codec_id:#x})"));
    }

    let mut description: Option<String> = None;
    loop {
        let mut header = [0u8; 12];
        if reader.read_exact(&mut header).await.is_err() {
            return Ok(());
        }
        let (config, pts, len) = parse_packet_header(&header);
        if len > MAX_PACKET {
            return Err("audio packet is too large".into());
        }
        let mut data = vec![0u8; len as usize];
        reader
            .read_exact(&mut data)
            .await
            .map_err(|e| format!("audio packet: {e}"))?;
        if config {
            let encoded = b64_encode(&data);
            description = Some(encoded.clone());
            hub.publish_status(AudioStatusFrame {
                serial: serial.to_string(),
                stream: StreamState::Streaming,
                note: "opus".into(),
                codec: "opus".into(),
                sample_rate: 48_000,
                channels: 2,
                framing: "opus-pts".into(),
                description: Some(encoded),
            })
            .await;
        } else {
            if description.is_none() {
                hub.publish_status(AudioStatusFrame {
                    serial: serial.to_string(),
                    stream: StreamState::Streaming,
                    note: "opus".into(),
                    codec: "opus".into(),
                    sample_rate: 48_000,
                    channels: 2,
                    framing: "opus-pts".into(),
                    description: None,
                })
                .await;
            }
            hub.publish_packet(serial, encode_opus_packet(pts, &data))
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    #[test]
    fn packet_header_splits_config_flag_and_size() {
        let mut header = [0u8; 12];
        let pts_flags = (1u64 << 63) | 1234;
        header[0..8].copy_from_slice(&pts_flags.to_be_bytes());
        header[8..12].copy_from_slice(&19u32.to_be_bytes());
        let (config, pts, len) = parse_packet_header(&header);
        assert!(config);
        assert_eq!(pts, 1234);
        assert_eq!(len, 19);
    }

    #[test]
    fn opus_packet_prefixes_pts() {
        let pkt = encode_opus_packet(99, &[0xf8, 0xff]);
        assert_eq!(&pkt[..8], &99u64.to_be_bytes());
        assert_eq!(&pkt[8..], &[0xf8, 0xff]);
    }

    #[tokio::test]
    async fn pump_reads_codec_config_and_one_packet() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            sock.write_all(&OPUS_CODEC_ID.to_be_bytes()).await.unwrap();
            let mut config = [0u8; 12];
            let flags = 1u64 << 63;
            config[0..8].copy_from_slice(&flags.to_be_bytes());
            config[8..12].copy_from_slice(&4u32.to_be_bytes());
            sock.write_all(&config).await.unwrap();
            sock.write_all(b"head").await.unwrap();
            let mut data = [0u8; 12];
            data[0..8].copy_from_slice(&50u64.to_be_bytes());
            data[8..12].copy_from_slice(&2u32.to_be_bytes());
            sock.write_all(&data).await.unwrap();
            sock.write_all(&[0xf8, 0xff]).await.unwrap();
        });

        let hub = AudioHub::new();
        let (mut rx, _) = hub.subscribe("SER").await;
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let pump = hub.clone();
        let task = tokio::spawn(async move {
            run_opus_pump(pump, "SER", stream).await.unwrap();
        });

        let mut saw_status = false;
        let mut saw_packet = false;
        for _ in 0..8 {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap();
            match frame {
                AudioFrame::Status(status) => {
                    assert_eq!(status.codec, "opus");
                    assert_eq!(status.description.as_deref(), Some(b64_encode(b"head").as_str()));
                    saw_status = true;
                }
                AudioFrame::Packet(bytes) => {
                    assert_eq!(&bytes[..8], &50u64.to_be_bytes());
                    assert_eq!(&bytes[8..], &[0xf8, 0xff]);
                    saw_packet = true;
                    break;
                }
            }
        }
        assert!(saw_status && saw_packet);
        let _ = task.await;
    }
}
