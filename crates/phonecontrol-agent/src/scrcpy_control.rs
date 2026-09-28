//! Scrcpy control socket: the same 32-byte touch messages the scrcpy client sends.
//!
//! With `tunnel_forward=true`, the device accepts the video socket, then the
//! control socket, and only then writes the dummy byte on the video socket.
//! Touch coordinates are in the encoded video size. A different screen size is
//! ignored by scrcpy.

use phonecontrol_protocol::{PointerPhase, PointerTool};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedReadHalf;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};

/// `SC_CONTROL_MSG_TYPE_INJECT_KEYCODE`
const INJECT_KEYCODE: u8 = 0;
/// `SC_CONTROL_MSG_TYPE_INJECT_TEXT`
const INJECT_TEXT: u8 = 1;
/// `SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT`
const INJECT_TOUCH_EVENT: u8 = 2;
/// scrcpy rejects text longer than this in one message.
const MAX_INJECT_TEXT: usize = 300;
/// `SC_CONTROL_MSG_TYPE_GET_CLIPBOARD`
const GET_CLIPBOARD: u8 = 8;
/// `SC_CONTROL_MSG_TYPE_SET_CLIPBOARD`
const SET_CLIPBOARD: u8 = 9;
/// `SC_CONTROL_MSG_TYPE_SET_DISPLAY_POWER`
const SET_DISPLAY_POWER: u8 = 10;
/// `SC_CONTROL_MSG_TYPE_RESET_VIDEO` — ask the encoder for a fresh keyframe.
const RESET_VIDEO: u8 = 17;
/// `AMOTION_EVENT_ACTION_HOVER_MOVE`
const ACTION_HOVER_MOVE: u8 = 7;
/// `AMOTION_EVENT_ACTION_HOVER_EXIT`
const ACTION_HOVER_EXIT: u8 = 10;
/// `AMOTION_EVENT_BUTTON_PRIMARY`
const BUTTON_PRIMARY: u32 = 1;
/// `SC_POINTER_ID_MOUSE` (`-1`). Hover and clicks from a PC mouse use this id.
const POINTER_ID_MOUSE: u64 = u64::MAX;
/// `SC_SCREEN_POWER_MODE_OFF`
const POWER_OFF: u8 = 0;
/// `SC_SCREEN_POWER_MODE_NORMAL`
const POWER_NORMAL: u8 = 2;
const MAX_CLIPBOARD: usize = 256 * 1024;
/// `SC_POINTER_ID_GENERIC_FINGER` (`-2`). Primary mouse clicks are also turned
/// into a finger by scrcpy; a finger id is a touch, which is what a swipe is.
const POINTER_ID_FINGER: u64 = u64::MAX - 1;

#[derive(Clone)]
pub struct ControlSender {
    tx: mpsc::Sender<Vec<u8>>,
    /// `(generation, text)`. Generation bumps on every phone clipboard message.
    clipboard_rx: watch::Receiver<(u64, String)>,
    sequence: Arc<AtomicU64>,
}

impl ControlSender {
    pub fn spawn(stream: TcpStream) -> Self {
        let _ = stream.set_nodelay(true);
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
        let (read, mut write) = stream.into_split();
        let (clip_tx, clip_rx) = watch::channel((0u64, String::new()));
        let clip_reader = clip_tx.clone();
        tokio::spawn(async move {
            let _ = read_device_messages(read, clip_reader).await;
        });
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.write_all(&msg).await.is_err() {
                    break;
                }
            }
        });
        Self {
            tx,
            clipboard_rx: clip_rx,
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn clipboard_receiver(&self) -> watch::Receiver<(u64, String)> {
        self.clipboard_rx.clone()
    }

    async fn send_raw(&self, msg: Vec<u8>) -> Result<(), String> {
        self.tx
            .send(msg)
            .await
            .map_err(|_| "scrcpy control socket closed".to_string())
    }

    pub async fn touch(
        &self,
        phase: PointerPhase,
        tool: PointerTool,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let msg = encode_pointer(phase, tool, x, y, width, height)?.to_vec();
        self.send_raw(msg).await
    }

    /// Scrcpy `RESET_VIDEO`. The server emits a new keyframe without exiting.
    pub async fn reset_video(&self) -> Result<(), String> {
        self.send_raw(vec![RESET_VIDEO]).await
    }

    /// `on == false` is scrcpy's "turn device screen off" (mode 0). Mode 2 turns it back on.
    pub async fn set_display_power(&self, on: bool) -> Result<(), String> {
        self.send_raw(encode_display_power(on).to_vec()).await
    }

    /// Printable text. Scrcpy types it into the focused field.
    pub async fn inject_text(&self, text: &str) -> Result<(), String> {
        self.send_raw(encode_inject_text(text)?).await
    }

    /// Android keycode. `action` is 0 (down) or 1 (up), matching `AKEY_EVENT_ACTION_*`.
    pub async fn inject_keycode(
        &self,
        action: u8,
        keycode: u32,
        repeat: u32,
        metastate: u32,
    ) -> Result<(), String> {
        self.send_raw(encode_inject_keycode(action, keycode, repeat, metastate)?.to_vec())
            .await
    }

    /// Copy `text` to the phone clipboard. `paste` also injects it into the focused field.
    pub async fn set_clipboard(&self, text: &str, paste: bool) -> Result<(), String> {
        if text.len() > MAX_CLIPBOARD {
            return Err("clipboard text is too long".into());
        }
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        self.send_raw(encode_set_clipboard(sequence, paste, text))
            .await
    }

    /// Ask the phone for its clipboard and wait until a device clipboard message arrives.
    pub async fn pull_clipboard(&self) -> Result<String, String> {
        let mut rx = self.clipboard_rx.clone();
        rx.borrow_and_update();
        self.send_raw(encode_get_clipboard().to_vec()).await?;
        let wait = rx.changed();
        match tokio::time::timeout(Duration::from_millis(800), wait).await {
            Ok(Ok(())) => Ok(rx.borrow().1.clone()),
            Ok(Err(_)) => Err("scrcpy control socket closed".into()),
            Err(_) => Err("phone did not send its clipboard".into()),
        }
    }
}

pub fn encode_inject_text(text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return Err("empty text".into());
    }
    if bytes.len() > MAX_INJECT_TEXT {
        return Err("text is too long for one scrcpy inject".into());
    }
    let mut buf = Vec::with_capacity(5 + bytes.len());
    buf.push(INJECT_TEXT);
    buf.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(bytes);
    Ok(buf)
}

pub fn encode_inject_keycode(
    action: u8,
    keycode: u32,
    repeat: u32,
    metastate: u32,
) -> Result<[u8; 14], String> {
    if action > 1 {
        return Err("key action must be down or up".into());
    }
    let mut buf = [0u8; 14];
    buf[0] = INJECT_KEYCODE;
    buf[1] = action;
    buf[2..6].copy_from_slice(&keycode.to_be_bytes());
    buf[6..10].copy_from_slice(&repeat.to_be_bytes());
    buf[10..14].copy_from_slice(&metastate.to_be_bytes());
    Ok(buf)
}

pub fn encode_display_power(on: bool) -> [u8; 2] {
    [SET_DISPLAY_POWER, if on { POWER_NORMAL } else { POWER_OFF }]
}

pub fn encode_get_clipboard() -> [u8; 2] {
    [GET_CLIPBOARD, 0]
}

pub fn encode_set_clipboard(sequence: u64, paste: bool, text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut buf = Vec::with_capacity(14 + bytes.len());
    buf.push(SET_CLIPBOARD);
    buf.extend_from_slice(&sequence.to_be_bytes());
    buf.push(u8::from(paste));
    buf.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(bytes);
    buf
}

/// Bytes consumed from the front of `buf`. `None` means a full message is not here yet.
pub fn consume_device_message(buf: &[u8]) -> Result<Option<(usize, Option<String>)>, ()> {
    if buf.is_empty() {
        return Ok(None);
    }
    match buf[0] {
        0 => {
            if buf.len() < 5 {
                return Ok(None);
            }
            let len = u32::from_be_bytes(buf[1..5].try_into().unwrap()) as usize;
            if len > MAX_CLIPBOARD {
                return Err(());
            }
            if buf.len() < 5 + len {
                return Ok(None);
            }
            let text = String::from_utf8_lossy(&buf[5..5 + len]).into_owned();
            Ok(Some((5 + len, Some(text))))
        }
        1 => {
            if buf.len() < 9 {
                return Ok(None);
            }
            Ok(Some((9, None)))
        }
        2 => {
            if buf.len() < 5 {
                return Ok(None);
            }
            let size = u16::from_be_bytes([buf[3], buf[4]]) as usize;
            if size > 64 * 1024 {
                return Err(());
            }
            if buf.len() < 5 + size {
                return Ok(None);
            }
            Ok(Some((5 + size, None)))
        }
        _ => Ok(Some((1, None))),
    }
}

async fn read_device_messages(
    mut read: OwnedReadHalf,
    clipboard: watch::Sender<(u64, String)>,
) -> Result<(), String> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = read
            .read(&mut tmp)
            .await
            .map_err(|e| format!("control read: {e}"))?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        loop {
            match consume_device_message(&buf) {
                Ok(Some((used, text))) => {
                    buf.drain(..used);
                    if let Some(text) = text {
                        clipboard.send_modify(|slot| {
                            slot.0 = slot.0.wrapping_add(1);
                            slot.1 = text.clone();
                        });
                    }
                }
                Ok(None) => break,
                Err(()) => return Err("scrcpy device message was not usable".into()),
            }
        }
    }
}

/// One scrcpy socket (audio-only server): connect, then read the dummy byte.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn open_audio_socket(addr: SocketAddr, budget: Duration) -> Result<TcpStream, String> {
    let start = std::time::Instant::now();
    let mut last = "scrcpy audio server did not send the handshake byte".to_string();
    while start.elapsed() < budget {
        match TcpStream::connect(addr).await {
            Ok(mut stream) => {
                let mut byte = [0u8; 1];
                match tokio::time::timeout(Duration::from_millis(400), stream.read_exact(&mut byte))
                    .await
                {
                    Ok(Ok(_)) => {
                        let _ = stream.set_nodelay(true);
                        return Ok(stream);
                    }
                    Ok(Err(e)) => {
                        last = format!("audio socket closed before handshake: {e}");
                    }
                    Err(_) => {
                        last =
                            "scrcpy audio server accepted TCP but did not send the handshake byte"
                                .into();
                    }
                }
            }
            Err(e) => {
                last = format!("audio TCP connect failed: {e}");
            }
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    Err(last)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn encode_touch(
    phase: PointerPhase,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<[u8; 32], String> {
    encode_pointer(phase, PointerTool::Finger, x, y, width, height)
}

/// Same 32-byte layout as scrcpy's `INJECT_TOUCH_EVENT`.
///
/// A mouse uses pointer id -1. Moving it with no button down is
/// `ACTION_HOVER_MOVE`, which is how scrcpy keeps the cursor inside the device
/// screen. A finger uses pointer id -2 and has no hover.
pub fn encode_pointer(
    phase: PointerPhase,
    tool: PointerTool,
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
    let (action, pressure, action_button, buttons, pointer_id) = match tool {
        PointerTool::Finger => {
            let action = match phase {
                PointerPhase::Down => 0u8,
                PointerPhase::Up => 1,
                PointerPhase::Move | PointerPhase::Hover => 2,
                PointerPhase::Cancel | PointerPhase::Leave => 3,
            };
            let pressure: u16 = match phase {
                PointerPhase::Up | PointerPhase::Cancel | PointerPhase::Leave => 0,
                PointerPhase::Down | PointerPhase::Move | PointerPhase::Hover => 0xffff,
            };
            (action, pressure, 0u32, 0u32, POINTER_ID_FINGER)
        }
        PointerTool::Mouse => match phase {
            PointerPhase::Hover => (ACTION_HOVER_MOVE, 0, 0, 0, POINTER_ID_MOUSE),
            PointerPhase::Leave => (ACTION_HOVER_EXIT, 0, 0, 0, POINTER_ID_MOUSE),
            PointerPhase::Down => (0, 0xffff, BUTTON_PRIMARY, BUTTON_PRIMARY, POINTER_ID_MOUSE),
            PointerPhase::Move => (2, 0xffff, 0, BUTTON_PRIMARY, POINTER_ID_MOUSE),
            PointerPhase::Up => (1, 0, BUTTON_PRIMARY, 0, POINTER_ID_MOUSE),
            PointerPhase::Cancel => (3, 0, 0, 0, POINTER_ID_MOUSE),
        },
    };

    let mut buf = [0u8; 32];
    buf[0] = INJECT_TOUCH_EVENT;
    buf[1] = action;
    buf[2..10].copy_from_slice(&pointer_id.to_be_bytes());
    buf[10..14].copy_from_slice(&(x as i32).to_be_bytes());
    buf[14..18].copy_from_slice(&(y as i32).to_be_bytes());
    buf[18..20].copy_from_slice(&width.to_be_bytes());
    buf[20..22].copy_from_slice(&height.to_be_bytes());
    buf[22..24].copy_from_slice(&pressure.to_be_bytes());
    buf[24..28].copy_from_slice(&action_button.to_be_bytes());
    buf[28..32].copy_from_slice(&buttons.to_be_bytes());
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
    fn inject_text_and_keycode_match_scrcpy_layout() {
        let text = encode_inject_text("Hi").unwrap();
        assert_eq!(text[0], 1);
        assert_eq!(&text[1..5], &2u32.to_be_bytes());
        assert_eq!(&text[5..], b"Hi");
        assert!(encode_inject_text("").is_err());

        let down = encode_inject_keycode(0, 66, 0, 0x1).unwrap();
        assert_eq!(down.len(), 14);
        assert_eq!(down[0], 0);
        assert_eq!(down[1], 0);
        assert_eq!(&down[2..6], &66u32.to_be_bytes());
        assert_eq!(&down[6..10], &0u32.to_be_bytes());
        assert_eq!(&down[10..14], &0x1u32.to_be_bytes());
        let up = encode_inject_keycode(1, 67, 0, 0).unwrap();
        assert_eq!(up[1], 1);
        assert_eq!(&up[2..6], &67u32.to_be_bytes());
        assert!(encode_inject_keycode(2, 66, 0, 0).is_err());
    }

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
    fn mouse_hover_uses_scrcpy_pointer_id() {
        let hover = encode_pointer(PointerPhase::Hover, PointerTool::Mouse, 4, 8, 1080, 2400)
            .unwrap();
        assert_eq!(hover[0], 2);
        assert_eq!(hover[1], 7);
        assert_eq!(&hover[2..10], &u64::MAX.to_be_bytes());
        assert_eq!(&hover[22..24], &0u16.to_be_bytes());
        assert_eq!(&hover[24..32], &[0u8; 8]);

        let down =
            encode_pointer(PointerPhase::Down, PointerTool::Mouse, 4, 8, 1080, 2400).unwrap();
        assert_eq!(down[1], 0);
        assert_eq!(&down[2..10], &u64::MAX.to_be_bytes());
        assert_eq!(&down[22..24], &0xffffu16.to_be_bytes());
        assert_eq!(&down[24..28], &1u32.to_be_bytes());
        assert_eq!(&down[28..32], &1u32.to_be_bytes());

        let leave =
            encode_pointer(PointerPhase::Leave, PointerTool::Mouse, 4, 8, 1080, 2400).unwrap();
        assert_eq!(leave[1], 10);
        assert_eq!(&leave[2..10], &u64::MAX.to_be_bytes());
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
            .touch(PointerPhase::Move, PointerTool::Finger, 10, 20, 576, 1280)
            .await
            .unwrap();
        let buf = reader.await.unwrap();
        assert_eq!(
            buf,
            encode_touch(PointerPhase::Move, 10, 20, 576, 1280).unwrap()
        );
        assert_eq!(buf[1], 2);
    }

    #[test]
    fn display_power_and_clipboard_match_scrcpy_layout() {
        assert_eq!(encode_display_power(false), [10, 0]);
        assert_eq!(encode_display_power(true), [10, 2]);
        assert_eq!(encode_get_clipboard(), [8, 0]);
        let set = encode_set_clipboard(7, true, "hi");
        assert_eq!(set[0], 9);
        assert_eq!(&set[1..9], &7u64.to_be_bytes());
        assert_eq!(set[9], 1);
        assert_eq!(&set[10..14], &2u32.to_be_bytes());
        assert_eq!(&set[14..], b"hi");
    }

    #[test]
    fn device_clipboard_message_is_consumed() {
        let mut buf = vec![0u8];
        buf.extend_from_slice(&5u32.to_be_bytes());
        buf.extend_from_slice(b"paste");
        buf.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0, 3]);
        let (used, text) = consume_device_message(&buf).unwrap().unwrap();
        assert_eq!(used, 10);
        assert_eq!(text.as_deref(), Some("paste"));
        let (used, text) = consume_device_message(&buf[10..]).unwrap().unwrap();
        assert_eq!(used, 9);
        assert!(text.is_none());
        assert!(consume_device_message(&[0, 0, 0]).unwrap().is_none());
    }

    #[tokio::test]
    async fn pull_clipboard_reads_the_device_message() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = [0u8; 2];
            sock.read_exact(&mut req).await.unwrap();
            assert_eq!(req, [8, 0]);
            let mut msg = vec![0u8];
            msg.extend_from_slice(&4u32.to_be_bytes());
            msg.extend_from_slice(b"from");
            sock.write_all(&msg).await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let stream = TcpStream::connect(addr).await.unwrap();
        let sender = ControlSender::spawn(stream);
        let text = sender.pull_clipboard().await.unwrap();
        assert_eq!(text, "from");
    }

    #[tokio::test]
    async fn audio_socket_waits_for_the_dummy_byte() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = sock.shutdown().await;
            let (mut sock, _) = listener.accept().await.unwrap();
            sock.write_all(&[0x00, 0x6f]).await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let mut stream = open_audio_socket(addr, Duration::from_secs(3))
            .await
            .unwrap();
        let mut next = [0u8; 1];
        stream.read_exact(&mut next).await.unwrap();
        assert_eq!(next, [0x6f]);
    }
}
