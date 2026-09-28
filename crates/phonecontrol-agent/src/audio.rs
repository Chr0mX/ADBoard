//! Opus audio from a second scrcpy-server (`video=false`), fanned out to
//! `/ws/devices/{serial}/audio`.
//!
//! The video server stays `raw_stream=true` with no frame headers. Audio uses
//! its own socket so those headers never land on the H264 parser.
//!
//! An audio-only server's socket is the *first* socket, so scrcpy writes the
//! same prefix the official client reads (`DesktopConnection.sendDeviceMeta`):
//! the dummy byte (consumed during connect), then a 64-byte device name, then
//! the 4-byte codec id. The name is the phone model (`2312DRAABC` on this
//! Redmi). Reading those bytes as a codec id yields `0x32333132`.
//!
//! Packet headers are 12 bytes (`pts+flags` u64 BE, size u32 BE). scrcpy 3.x
//! marks a config packet with bit 63. scrcpy 4.x moved that to bit 62 and uses
//! bit 63 for video session packets. The Opus description itself starts with
//! `OpusHead`, which is what the player needs.

use phonecontrol_protocol::{AudioStatusFrame, StreamState};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{broadcast, Mutex};
use tracing::warn;

pub const OPUS_CODEC_ID: u32 = 0x6f70_7573;
const AAC_CODEC_ID: u32 = 0x0061_6163;
const FLAC_CODEC_ID: u32 = 0x666c_6163;
const RAW_CODEC_ID: u32 = 0x0072_6177;
/// `DesktopConnection.DEVICE_NAME_FIELD_LENGTH` in scrcpy 4.1.
const DEVICE_NAME_LEN: usize = 64;
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
        let (tx, _) = broadcast::channel(180);
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
///
/// `legacy_config` is bit 63, the scrcpy 3.x config flag. scrcpy 4.x uses that
/// bit for video session packets and puts the config flag in bit 62; the pump
/// also treats a payload that starts with `OpusHead` as the description.
/// PTS keeps the low 61 bits so neither generation's flag bits leak into it.
pub fn parse_packet_header(header: &[u8; 12]) -> (bool, u64, u32) {
    let pts_flags = u64::from_be_bytes(header[0..8].try_into().unwrap());
    let legacy_config = pts_flags & (1 << 63) != 0;
    let pts = pts_flags & ((1 << 61) - 1);
    let len = u32::from_be_bytes(header[8..12].try_into().unwrap());
    (legacy_config, pts, len)
}

fn is_known_audio_codec(id: u32) -> bool {
    matches!(id, OPUS_CODEC_ID | AAC_CODEC_ID | FLAC_CODEC_ID | RAW_CODEC_ID)
}

fn codec_id_error(codec_id: u32) -> Result<u32, String> {
    match codec_id {
        OPUS_CODEC_ID => Ok(codec_id),
        0 => Err("device turned audio capture off".into()),
        1 => Err("scrcpy audio configuration error".into()),
        AAC_CODEC_ID | FLAC_CODEC_ID | RAW_CODEC_ID => Err(format!(
            "audio codec is not opus ({codec_id:#x})"
        )),
        _ => Err(format!("audio codec is not opus ({codec_id:#x})")),
    }
}

fn opus_head(data: &[u8]) -> bool {
    data.starts_with(b"OpusHead")
}

/// Codec id, after the 64-byte device name when this socket is the first one.
async fn read_audio_codec<R>(reader: &mut R, serial: &str) -> Result<u32, String>
where
    R: AsyncRead + Unpin,
{
    let mut word = [0u8; 4];
    reader
        .read_exact(&mut word)
        .await
        .map_err(|e| format!("audio codec id: {e}"))?;
    let first = u32::from_be_bytes(word);
    if is_known_audio_codec(first) || first <= 1 {
        return codec_id_error(first);
    }
    let mut rest = [0u8; DEVICE_NAME_LEN - 4];
    reader
        .read_exact(&mut rest)
        .await
        .map_err(|e| format!("audio device name: {e}"))?;
    let mut name = [0u8; DEVICE_NAME_LEN];
    name[..4].copy_from_slice(&word);
    name[4..].copy_from_slice(&rest);
    let end = name.iter().position(|b| *b == 0).unwrap_or(name.len());
    let device = String::from_utf8_lossy(&name[..end]);
    tracing::info!(%serial, %device, "scrcpy audio device name");
    reader
        .read_exact(&mut word)
        .await
        .map_err(|e| format!("audio codec id: {e}"))?;
    codec_id_error(u32::from_be_bytes(word))
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
    read_audio_codec(&mut reader, serial).await?;

    let mut description: Option<String> = None;
    loop {
        let mut header = [0u8; 12];
        if reader.read_exact(&mut header).await.is_err() {
            return Ok(());
        }
        let (legacy_config, pts, len) = parse_packet_header(&header);
        if len > MAX_PACKET {
            return Err("audio packet is too large".into());
        }
        let mut data = vec![0u8; len as usize];
        reader
            .read_exact(&mut data)
            .await
            .map_err(|e| format!("audio packet: {e}"))?;
        // 3.x sets bit 63. 4.x sets bit 62 and the payload is the OpusHead
        // block the browser has to configure with.
        let config = legacy_config || opus_head(&data);
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

        // scrcpy 4.x: bit 62 is the config flag, bit 61 is the keyframe flag.
        let mut v4 = [0u8; 12];
        let flags = (1u64 << 62) | (1u64 << 61) | 77;
        v4[0..8].copy_from_slice(&flags.to_be_bytes());
        v4[8..12].copy_from_slice(&8u32.to_be_bytes());
        let (legacy, pts, len) = parse_packet_header(&v4);
        assert!(!legacy);
        assert_eq!(pts, 77);
        assert_eq!(len, 8);
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

    #[tokio::test]
    async fn pump_skips_device_name_and_reads_scrcpy4_config() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut name = [0u8; 64];
            name[..10].copy_from_slice(b"2312DRAABC");
            sock.write_all(&name).await.unwrap();
            sock.write_all(&OPUS_CODEC_ID.to_be_bytes()).await.unwrap();
            let mut config = [0u8; 12];
            let flags = 1u64 << 62;
            config[0..8].copy_from_slice(&flags.to_be_bytes());
            config[8..12].copy_from_slice(&8u32.to_be_bytes());
            sock.write_all(&config).await.unwrap();
            sock.write_all(b"OpusHead").await.unwrap();
            let mut data = [0u8; 12];
            data[0..8].copy_from_slice(&50u64.to_be_bytes());
            data[8..12].copy_from_slice(&2u32.to_be_bytes());
            sock.write_all(&data).await.unwrap();
            sock.write_all(&[0xf8, 0xff]).await.unwrap();
        });

        let hub = AudioHub::new();
        let (mut rx, _) = hub.subscribe("2312DRAABC").await;
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let pump = hub.clone();
        let task = tokio::spawn(async move {
            run_opus_pump(pump, "2312DRAABC", stream).await.unwrap();
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
                    assert_eq!(status.stream, StreamState::Streaming);
                    assert_eq!(
                        status.description.as_deref(),
                        Some(b64_encode(b"OpusHead").as_str())
                    );
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
