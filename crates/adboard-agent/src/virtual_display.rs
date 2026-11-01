//! Independent Android display, created by the scrcpy server itself.
//!
//! scrcpy-server 3.x creates a `VirtualDisplay` when started with
//! `new_display=<W>x<H>/<dpi>`, encodes it, and sends input to it. ADBoard runs
//! it as a second server on the same phone: its own `scid` (so its own abstract
//! socket `scrcpy_<scid>`), its own forward port, and a key `<serial>#vd<N>`
//! that the video hub and the UI treat as one more screen.
//!
//! This module only builds commands and parses text. It has no I/O and no crate
//! dependencies, so it is unit-testable on its own. Option names follow
//! scrcpy-server 3.x and must be confirmed against the pinned version.

use std::fmt;

/// Smallest and largest side the agent accepts (the encoder limit in practice).
pub const MIN_SIDE: u32 = 120;
pub const MAX_SIDE: u32 = 4096;
pub const MIN_DPI: u32 = 72;
pub const MAX_DPI: u32 = 640;
/// More displays than this per phone means more phone-side encodes than a
/// phone sustains; the API refuses beyond it.
pub const DEFAULT_PER_PHONE: u32 = 1;
/// Highest value `ADBOARD_MAX_VIRTUAL_DISPLAYS` can raise the limit to.
pub const CEILING_PER_PHONE: u32 = 4;
/// Virtual displays need Android 13 (API 33) or newer.
pub const MIN_SDK: u32 = 33;

/// Virtual displays need scrcpy-server 3.0 or newer (`new_display`).
pub fn server_supported(version: &str) -> bool {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 3)
}

/// The per-phone limit from the value of `ADBOARD_MAX_VIRTUAL_DISPLAYS`: the
/// default when unset or not a number, clamped to `1..=CEILING_PER_PHONE`.
pub fn limit_from(value: Option<&str>) -> u32 {
    value
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(DEFAULT_PER_PHONE)
        .clamp(1, CEILING_PER_PHONE)
}

/// The limit chosen in Settings; 0 means none chosen (the environment decides).
static LIMIT_OVERRIDE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Use `limit` (clamped to `1..=CEILING_PER_PHONE`) instead of the environment,
/// or go back to the environment with `None`.
pub fn set_limit_override(limit: Option<u32>) {
    let value = limit.map_or(0, |n| n.clamp(1, CEILING_PER_PHONE));
    LIMIT_OVERRIDE.store(value, std::sync::atomic::Ordering::Relaxed);
}

pub fn limit_override() -> Option<u32> {
    match LIMIT_OVERRIDE.load(std::sync::atomic::Ordering::Relaxed) {
        0 => None,
        n => Some(n),
    }
}

/// `ADBOARD_MAX_VIRTUAL_DISPLAYS`, or the default of 1.
pub fn env_limit() -> u32 {
    limit_from(
        std::env::var("ADBOARD_MAX_VIRTUAL_DISPLAYS")
            .ok()
            .as_deref(),
    )
}

/// The limit in force: the Settings choice, else the environment, else 1.
pub fn max_per_phone() -> u32 {
    limit_override().unwrap_or_else(env_limit)
}

/// Display `index` (1-based) is allowed when it is within `limit`.
pub fn check_index(index: u32, limit: u32) -> Result<(), SpecError> {
    if index == 0 || index > limit {
        Err(SpecError::Index(index, limit))
    } else {
        Ok(())
    }
}

/// `ro.build.version.sdk` of the phone, as text. Anything below `MIN_SDK`, or
/// not a number, is refused.
pub fn sdk_supported(sdk: &str) -> bool {
    sdk.trim().parse::<u32>().is_ok_and(|n| n >= MIN_SDK)
}

/// First forward port for virtual displays: clear of video (27183..29183) and
/// audio (31183..33183).
const PORT_BASE: u16 = 34183;
const PORT_SPAN: u32 = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualDisplaySpec {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    /// `pkg`, `+pkg` (force-stop first) or `?name` (search by name), as
    /// scrcpy's `start_app`. Checked by [`valid_start_app`].
    pub start_app: Option<String>,
    /// Keep the display's apps when it closes (they move to the main
    /// display) instead of closing them.
    pub keep_content: bool,
}

impl Default for VirtualDisplaySpec {
    fn default() -> Self {
        Self {
            width: 1080,
            height: 1920,
            dpi: 320,
            start_app: None,
            keep_content: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecError {
    Size(u32, u32),
    Dpi(u32),
    StartApp(String),
    Index(u32, u32),
    Sdk(String),
}

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpecError::Size(w, h) => write!(
                f,
                "display size {w}x{h} is outside {MIN_SIDE}..={MAX_SIDE} on each side"
            ),
            SpecError::Dpi(d) => write!(f, "density {d} is outside {MIN_DPI}..={MAX_DPI}"),
            SpecError::StartApp(s) => write!(f, "{s:?} is not a package name to start"),
            SpecError::Index(n, limit) => write!(
                f,
                "virtual display {n} is past the limit of {limit} per phone"
            ),
            SpecError::Sdk(s) => write!(
                f,
                "Android API {s:?} is too old: virtual displays need API {MIN_SDK} (Android 13) or newer"
            ),
        }
    }
}

impl VirtualDisplaySpec {
    /// Reject anything the server command or the shell must not receive. The
    /// command is one shell string, so every field is checked, not escaped.
    pub fn validate(&self) -> Result<(), SpecError> {
        let side = MIN_SIDE..=MAX_SIDE;
        if !side.contains(&self.width) || !side.contains(&self.height) {
            return Err(SpecError::Size(self.width, self.height));
        }
        if !(MIN_DPI..=MAX_DPI).contains(&self.dpi) {
            return Err(SpecError::Dpi(self.dpi));
        }
        if let Some(app) = &self.start_app {
            if !valid_start_app(app) {
                return Err(SpecError::StartApp(app.clone()));
            }
        }
        Ok(())
    }
}

/// `pkg`, `+pkg` or `?name`. Package characters only, so the value is safe in a
/// shell string. The `?` form takes letters, digits, `.`, `_`, `-` (no spaces).
pub fn valid_start_app(value: &str) -> bool {
    let body = value.strip_prefix(['+', '?']).unwrap_or(value);
    !body.is_empty()
        && body.len() <= 200
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `pkg/.Activity` or `pkg/com.x.Activity$Inner` for `am start -n`.
pub fn valid_component(value: &str) -> bool {
    let Some((pkg, activity)) = value.split_once('/') else {
        return false;
    };
    let part_ok = |s: &str, extra: &[char]| {
        !s.is_empty()
            && s.len() <= 200
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || extra.contains(&c))
    };
    part_ok(pkg, &[]) && part_ok(activity, &['$'])
}

/// The key the hub, the session map and the UI use for display `index` (1-based)
/// of `serial`. The real serial stays the adb target.
pub fn display_key(serial: &str, index: u32) -> String {
    format!("{serial}#vd{index}")
}

/// Split a key made by [`display_key`] back into `(serial, index)`.
pub fn parse_display_key(key: &str) -> Option<(&str, u32)> {
    let (serial, rest) = key.rsplit_once("#vd")?;
    let index = rest.parse::<u32>().ok()?;
    if serial.is_empty() || index == 0 {
        return None;
    }
    Some((serial, index))
}

fn hash(text: &str) -> u32 {
    let mut h = 0u32;
    for b in text.bytes() {
        h = h.wrapping_mul(31).wrapping_add(u32::from(b));
    }
    h
}

/// Server id. Hex in the command (`Options.parse` reads base 16), never `-1`
/// (that is the video server's default socket) and never 0.
pub fn scid(serial: &str, index: u32) -> u32 {
    let id = hash(&display_key(serial, index)) & 0x7fff_fffe;
    if id == 0 {
        2
    } else {
        id
    }
}

pub fn socket_name(scid: u32) -> String {
    format!("scrcpy_{scid:08x}")
}

pub fn local_port(serial: &str, index: u32) -> u16 {
    PORT_BASE + (hash(&display_key(serial, index)) % PORT_SPAN) as u16
}

/// `app_process` command line for the virtual-display server. `bit_rate` and
/// `max_fps` come from the quality preset. The video and control sockets share
/// one server, like the physical-screen session.
pub fn build_server_command(
    remote_jar: &str,
    version: &str,
    scid: u32,
    spec: &VirtualDisplaySpec,
    bit_rate: Option<u32>,
    max_fps: Option<u32>,
) -> String {
    let mut opts = vec![
        format!("scid={scid:x}"),
        "log_level=info".to_string(),
        "tunnel_forward=true".to_string(),
        "audio=false".to_string(),
        "control=true".to_string(),
        "cleanup=false".to_string(),
        "raw_stream=true".to_string(),
        "send_dummy_byte=true".to_string(),
        "video_codec=h264".to_string(),
        format!("new_display={}x{}/{}", spec.width, spec.height, spec.dpi),
    ];
    if let Some(rate) = bit_rate {
        opts.push(format!("video_bit_rate={rate}"));
    }
    if let Some(fps) = max_fps {
        opts.push(format!("max_fps={fps}"));
    }
    if let Some(app) = &spec.start_app {
        opts.push(format!("start_app={app}"));
    }
    if spec.keep_content {
        opts.push("vd_destroy_content=false".to_string());
    }
    format!(
        "CLASSPATH={remote_jar} app_process / com.genymobile.scrcpy.Server {version} {}",
        opts.join(" ")
    )
}

/// The created display's id, from a server log line such as
/// `New display: 1080x1920/320 (id=7)`. Only lines that mention a display are
/// read, so `id=` in an unrelated line is not mistaken for it.
pub fn parse_display_id(line: &str) -> Option<u32> {
    if !line.to_ascii_lowercase().contains("display") {
        return None;
    }
    let after = &line[line.find("id=")? + 3..];
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// adb arguments that start `component` on display `display_id`.
pub fn am_start_args(display_id: u32, component: &str) -> Result<Vec<String>, SpecError> {
    if !valid_component(component) {
        return Err(SpecError::StartApp(component.to_string()));
    }
    Ok(vec![
        "shell".into(),
        "am".into(),
        "start".into(),
        "--display".into(),
        display_id.to_string(),
        "-n".into(),
        component.to_string(),
    ])
}

/// adb arguments for an `input` command on a display. Plain `input` goes to the
/// default display, so every shell input to a virtual display needs `-d`.
pub fn input_args(display_id: u32, rest: &[&str]) -> Vec<String> {
    let mut args = vec![
        "shell".to_string(),
        "input".to_string(),
        "-d".to_string(),
        display_id.to_string(),
    ];
    args.extend(rest.iter().map(|s| s.to_string()));
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_defaults_to_one_and_is_clamped() {
        assert_eq!(limit_from(None), 1);
        assert_eq!(limit_from(Some("")), 1);
        assert_eq!(limit_from(Some("abc")), 1);
        assert_eq!(limit_from(Some("0")), 1);
        assert_eq!(limit_from(Some(" 2 ")), 2);
        assert_eq!(limit_from(Some("99")), CEILING_PER_PHONE);
        assert_eq!(check_index(1, 1), Ok(()));
        assert_eq!(check_index(2, 1), Err(SpecError::Index(2, 1)));
        assert_eq!(check_index(0, 2), Err(SpecError::Index(0, 2)));
        assert_eq!(check_index(2, 2), Ok(()));
    }

    #[test]
    fn a_limit_chosen_in_settings_wins_over_the_environment() {
        let before = limit_override();
        set_limit_override(Some(3));
        assert_eq!(max_per_phone(), 3);
        set_limit_override(Some(99));
        assert_eq!(max_per_phone(), CEILING_PER_PHONE);
        set_limit_override(Some(0));
        assert_eq!(max_per_phone(), 1);
        set_limit_override(None);
        assert_eq!(limit_override(), None);
        assert_eq!(max_per_phone(), env_limit());
        set_limit_override(before);
    }

    #[test]
    fn server_must_be_3_or_newer() {
        assert!(server_supported("3.0"));
        assert!(server_supported("v3.3.1"));
        assert!(server_supported("4.1"));
        assert!(!server_supported("2.7"));
        assert!(!server_supported("1.25"));
        assert!(!server_supported(""));
        assert!(!server_supported("dev"));
    }

    #[test]
    fn android_13_or_newer_only() {
        assert!(sdk_supported("33"));
        assert!(sdk_supported("35\n"));
        assert!(!sdk_supported("32"));
        assert!(!sdk_supported(""));
        assert!(!sdk_supported("tiramisu"));
    }

    #[test]
    fn default_spec_is_valid() {
        assert_eq!(VirtualDisplaySpec::default().validate(), Ok(()));
    }

    #[test]
    fn size_and_density_limits() {
        let mut s = VirtualDisplaySpec::default();
        s.width = 100;
        assert_eq!(s.validate(), Err(SpecError::Size(100, 1920)));
        s.width = 1080;
        s.height = 5000;
        assert_eq!(s.validate(), Err(SpecError::Size(1080, 5000)));
        s.height = 1920;
        s.dpi = 10;
        assert_eq!(s.validate(), Err(SpecError::Dpi(10)));
        s.dpi = 641;
        assert_eq!(s.validate(), Err(SpecError::Dpi(641)));
    }

    #[test]
    fn start_app_cannot_carry_shell_syntax() {
        for ok in ["org.mozilla.firefox", "+com.a.b", "?Firefox", "a_b-c.d"] {
            assert!(valid_start_app(ok), "{ok}");
        }
        for bad in [
            "", "+", "a b", "a;reboot", "a&&b", "$(id)", "a`b`", "a|b", "a\nb", "a'b", "a\"b", "?",
        ] {
            assert!(!valid_start_app(bad), "{bad:?}");
        }
        let s = VirtualDisplaySpec {
            start_app: Some("x;reboot".into()),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err(SpecError::StartApp("x;reboot".into())));
    }

    #[test]
    fn component_checks() {
        assert!(valid_component("com.android.settings/.Settings"));
        assert!(valid_component("a.b/a.b.Main$Inner"));
        for bad in ["a.b", "/x", "a.b/", "a b/.X", "a.b/.X;id", "a.b/$X $(id)"] {
            assert!(!valid_component(bad), "{bad}");
        }
        assert!(am_start_args(3, "a.b/.X;id").is_err());
    }

    #[test]
    fn keys_round_trip() {
        assert_eq!(display_key("R5CW90ABC1", 2), "R5CW90ABC1#vd2");
        assert_eq!(parse_display_key("R5CW90ABC1#vd2"), Some(("R5CW90ABC1", 2)));
        // A wireless serial has ':' and '.'; a '#' in the serial is split at the last marker.
        assert_eq!(
            parse_display_key("192.168.1.5:5555#vd1"),
            Some(("192.168.1.5:5555", 1))
        );
        assert_eq!(parse_display_key("R5CW90ABC1"), None);
        assert_eq!(parse_display_key("R5CW90ABC1#vd0"), None);
        assert_eq!(parse_display_key("#vd1"), None);
        assert_eq!(parse_display_key("x#vdz"), None);
    }

    #[test]
    fn scid_is_valid_and_distinct() {
        for index in 1..=CEILING_PER_PHONE {
            let id = scid("R5CW90ABC1", index);
            assert_ne!(id, 0);
            assert_eq!(id & 1, 0, "bit 0 is kept clear like the audio scid");
            assert!(id <= 0x7fff_fffe);
        }
        assert_ne!(scid("R5CW90ABC1", 1), scid("R5CW90ABC1", 2));
        assert_ne!(scid("R5CW90ABC1", 1), scid("R3CT50XYZ9", 1));
        assert_eq!(socket_name(0xab), "scrcpy_000000ab");
    }

    #[test]
    fn port_is_clear_of_video_and_audio_ranges() {
        for serial in ["R5CW90ABC1", "R3CT50XYZ9", "192.168.1.5:5555", "x"] {
            for index in 1..=CEILING_PER_PHONE {
                let p = local_port(serial, index);
                assert!((34183..36183).contains(&p), "{p}");
            }
        }
    }

    #[test]
    fn command_has_new_display_and_its_own_scid() {
        let spec = VirtualDisplaySpec {
            start_app: Some("org.mozilla.firefox".into()),
            keep_content: true,
            ..Default::default()
        };
        let cmd = build_server_command(
            "/data/local/tmp/scrcpy-server.jar",
            "3.3.1",
            0xabc,
            &spec,
            Some(4_000_000),
            Some(30),
        );
        assert!(cmd.starts_with(
            "CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 3.3.1 "
        ));
        for want in [
            "scid=abc",
            "new_display=1080x1920/320",
            "raw_stream=true",
            "send_dummy_byte=true",
            "control=true",
            "audio=false",
            "video_codec=h264",
            "video_bit_rate=4000000",
            "max_fps=30",
            "start_app=org.mozilla.firefox",
            "vd_destroy_content=false",
        ] {
            assert!(cmd.split(' ').any(|o| o == want), "missing {want}: {cmd}");
        }
        assert!(!cmd.contains("scid=-1"));
        assert!(!cmd.contains("max_size"), "the display's own size is used");
    }

    #[test]
    fn command_omits_optional_flags() {
        let cmd =
            build_server_command("/j", "3.3.1", 2, &VirtualDisplaySpec::default(), None, None);
        for absent in [
            "video_bit_rate",
            "max_fps",
            "start_app",
            "vd_destroy_content",
        ] {
            assert!(!cmd.contains(absent), "{absent}");
        }
    }

    #[test]
    fn display_id_comes_only_from_display_lines() {
        assert_eq!(
            parse_display_id("New display: 1080x1920/320 (id=7)"),
            Some(7)
        );
        assert_eq!(
            parse_display_id("[server] INFO: New Display: 1x1/160 (id=12) ok"),
            Some(12)
        );
        assert_eq!(
            parse_display_id("Device: [Google] Pixel (Android 14) id=9"),
            None
        );
        assert_eq!(parse_display_id("New display: 1080x1920/320"), None);
        assert_eq!(parse_display_id("New display (id=)"), None);
        assert_eq!(parse_display_id(""), None);
    }

    #[test]
    fn adb_args_target_the_display() {
        assert_eq!(
            am_start_args(7, "com.android.settings/.Settings").unwrap(),
            [
                "shell",
                "am",
                "start",
                "--display",
                "7",
                "-n",
                "com.android.settings/.Settings"
            ]
        );
        assert_eq!(
            input_args(7, &["keyevent", "KEYCODE_BACK"]),
            ["shell", "input", "-d", "7", "keyevent", "KEYCODE_BACK"]
        );
    }
}
