//! Scrcpy control socket: the same 32-byte touch messages the scrcpy client sends.
//!
//! With `tunnel_forward=true`, the device accepts the video socket, then the
//! control socket, and only then writes the dummy byte on the video socket.
//! Touch coordinates are in the encoded video size. A different screen size is
//! ignored by scrcpy.

use phonecontrol_protocol::PointerPhase;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// `SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT`
const INJECT_TOUCH_EVENT: u8 = 2;
/// `SC_POINTER_ID_GENERIC_FINGER` (`-2`). Primary mouse clicks are also turned
/// into a finger by scrcpy; a finger id is a touch, which is what a swipe is.
const POINTER_ID_FINGER: u64 = u64::MAX - 1;

#[derive(Clone)]
pub struct ControlSender {
    tx: mpsc::Sender<[u8; 32]>,
}

impl ControlSender {
    pub fn spawn(mut stream: TcpStream) -> Self {
        let _ = stream.set_nodelay(true);
        let (tx, mut rx) = mpsc::channel::<[u8; 32]>(64);
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if stream.write_all(&msg).await.is_err() {
                    break;
                }
            }
        });
        Self { tx }
    }

    pub async fn touch(
        &self,
        phase: PointerPhase,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let msg = encode_touch(phase, x, y, width, height)?;
        self.tx
            .send(msg)
            .await
            .map_err(|_| "scrcpy control socket closed".to_string())
    }
}

pub fn encode_touch(
    phase: PointerPhase,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<[u8; 32], String> {
    let width = u16::try_from(width).map_err(|_| "video width does not fit scrcpy".to_string())?;
    let height =
        u16::try_from(height).map_err(|_| "video height does not fit scrcpy".to_string())?;
    if width == 0 || height == 0 {
        return Err("video size unknown — wait for the picture".into());
    }
    let x = x.min(u32::from(width.saturating_sub(1)));
    let y = y.min(u32::from(height.saturating_sub(1)));
    let action = match phase {
        PointerPhase::Down => 0u8,
        PointerPhase::Up => 1,
        PointerPhase::Move => 2,
        PointerPhase::Cancel => 3,
    };
    let pressure: u16 = match phase {
        PointerPhase::Up | PointerPhase::Cancel => 0,
        PointerPhase::Down | PointerPhase::Move => 0xffff,
    };

    let mut buf = [0u8; 32];
    buf[0] = INJECT_TOUCH_EVENT;
    buf[1] = action;
    buf[2..10].copy_from_slice(&POINTER_ID_FINGER.to_be_bytes());
    buf[10..14].copy_from_slice(&(x as i32).to_be_bytes());
    buf[14..18].copy_from_slice(&(y as i32).to_be_bytes());
    buf[18..20].copy_from_slice(&width.to_be_bytes());
    buf[20..22].copy_from_slice(&height.to_be_bytes());
    buf[22..24].copy_from_slice(&pressure.to_be_bytes());
    Ok(buf)
}

/// Connect the video socket and the control socket, then read the dummy byte
/// from the video socket.
///
/// Current scrcpy writes that byte only after both accepts. Reading it first
/// deadlocks the server in `accept()` and the picture never starts.
pub async fn open_video_and_control(
    addr: SocketAddr,
    budget: Duration,
) -> Result<(TcpStream, TcpStream), String> {
    let start = std::time::Instant::now();
    let mut last = "scrcpy-server did not complete the video and control handshake".to_string();
    while start.elapsed() < budget {
        let video = match TcpStream::connect(addr).await {
            Ok(stream) => stream,
            Err(e) => {
                last = format!("video TCP connect failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let control = match TcpStream::connect(addr).await {
            Ok(stream) => stream,
            Err(e) => {
                last = format!("control TCP connect failed: {e}");
                drop(video);
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let mut video = video;
        let mut byte = [0u8; 1];
        match tokio::time::timeout(Duration::from_millis(400), video.read_exact(&mut byte)).await {
            Ok(Ok(_)) => {
                let _ = video.set_nodelay(true);
                let _ = control.set_nodelay(true);
                return Ok((video, control));
            }
            Ok(Err(e)) => {
                last = format!("video socket closed before handshake: {e}");
            }
            Err(_) => {
                last = "scrcpy-server accepted video but did not send the handshake byte".into();
            }
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn touch_down_matches_scrcpy_layout() {
        let buf = encode_touch(PointerPhase::Down, 10, 20, 576, 1280).unwrap();
        assert_eq!(buf[0], 2);
        assert_eq!(buf[1], 0);
        assert_eq!(&buf[2..10], &POINTER_ID_FINGER.to_be_bytes());
        assert_eq!(&buf[10..14], &10i32.to_be_bytes());
        assert_eq!(&buf[14..18], &20i32.to_be_bytes());
        assert_eq!(&buf[18..20], &576u16.to_be_bytes());
        assert_eq!(&buf[20..22], &1280u16.to_be_bytes());
        assert_eq!(&buf[22..24], &0xffffu16.to_be_bytes());
        assert_eq!(&buf[24..], &[0u8; 8]);
    }

    #[test]
    fn touch_up_clears_pressure_and_clamps_to_frame() {
        let buf = encode_touch(PointerPhase::Up, 9999, 9999, 576, 1280).unwrap();
        assert_eq!(buf[1], 1);
        assert_eq!(&buf[10..14], &575i32.to_be_bytes());
        assert_eq!(&buf[14..18], &1279i32.to_be_bytes());
        assert_eq!(&buf[22..24], &0u16.to_be_bytes());
    }

    #[tokio::test]
    async fn dummy_byte_arrives_only_after_control_connects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut video, _) = listener.accept().await.unwrap();
            let (_control, _) = listener.accept().await.unwrap();
            video
                .write_all(&[0x00, 0x00, 0x00, 0x00, 0x01])
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });

        let (mut video, _control) = open_video_and_control(addr, Duration::from_secs(3))
            .await
            .expect("handshake");
        let mut rest = [0u8; 4];
        video.read_exact(&mut rest).await.unwrap();
        assert_eq!(rest, [0x00, 0x00, 0x00, 0x01]);
    }

    #[tokio::test]
    async fn sender_writes_one_touch_message() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let reader = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 32];
            sock.read_exact(&mut buf).await.unwrap();
            buf
        });
        let stream = TcpStream::connect(addr).await.unwrap();
        let sender = ControlSender::spawn(stream);
        sender
            .touch(PointerPhase::Move, 10, 20, 576, 1280)
            .await
            .unwrap();
        let buf = reader.await.unwrap();
        assert_eq!(
            buf,
            encode_touch(PointerPhase::Move, 10, 20, 576, 1280).unwrap()
        );
        assert_eq!(buf[1], 2);
    }
}
