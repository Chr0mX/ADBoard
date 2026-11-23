//! Sending the changes: one round of sound and screen operations for the phones that still need them.
use super::*;

/// Send the sound and screen changes for one group of phones that all want the same state:
/// sound muted (`mute_on`) or restored, screen off (`screen_off`) or on. Returns, per phone,
/// whether each operation succeeded (only for the ones asked for).
pub(super) async fn run_group(
    state: &AppState,
    online: &[&Device],
    audio_todo: &[String],
    screen_todo: &[String],
    mute_on: bool,
    screen_off: bool,
) -> (HashMap<String, bool>, HashMap<String, bool>) {
    let ids_of = |serials: &[String]| -> Vec<String> {
        online
            .iter()
            .filter(|d| serials.contains(&d.serial))
            .map(|d| d.id.clone())
            .collect()
    };

    // Sound: only the phones that still need it.
    let mut audio_out: HashMap<String, bool> = HashMap::new();
    if !audio_todo.is_empty() {
        let mute = state
            .run_command(DeviceCommandRequest {
                target_ids: ids_of(audio_todo),
                op: "mute".into(),
                arg: Some(if mute_on { "on" } else { "off" }.into()),
                arg2: None,
            })
            .await;
        for device in online.iter().filter(|d| audio_todo.contains(&d.serial)) {
            let ok = match &mute {
                Ok(response) => match response.results.iter().find(|r| r.device_id == device.id) {
                    Some(result) if result.ok => true,
                    Some(result) => {
                        warn!(phone = %device.name, error = ?result.error, "Quiet cycle: mute failed");
                        false
                    }
                    None => {
                        warn!(phone = %device.name, "Quiet cycle: mute gave no answer");
                        false
                    }
                },
                Err(error) => {
                    warn!(phone = %device.name, %error, "Quiet cycle: mute failed");
                    false
                }
            };
            audio_out.insert(device.serial.clone(), ok);
        }
    }

    // Screen: only the phones that still need it. The options call also records the wanted
    // state for streams that start later; it reports a result only for phones whose screen
    // state changed, so a retry for a local phone sends the power message itself.
    let mut screen_out: HashMap<String, bool> = HashMap::new();
    if !screen_todo.is_empty() {
        let prefs = state.inner.sessions.prefs().await;
        let options = state
            .run_scrcpy_options(ScrcpyOptionsRequest {
                mode: ControlMode::Selected,
                target_ids: ids_of(screen_todo),
                quality: prefs.quality.clone(),
                audio: prefs.audio,
                screen_off,
                max_size: prefs.max_size,
                video_bit_rate: prefs.video_bit_rate,
                max_fps: prefs.max_fps,
            })
            .await;
        let locals: Vec<String> = state
            .list_local_devices()
            .await
            .into_iter()
            .map(|d| d.serial)
            .collect();
        for device in online.iter().filter(|d| screen_todo.contains(&d.serial)) {
            let ok = match &options {
                Err(error) => {
                    warn!(phone = %device.name, %error, "Quiet cycle: screen power failed");
                    false
                }
                Ok(response) => match response.results.iter().find(|r| r.device_id == device.id) {
                    Some(result) if result.ok => true,
                    Some(result) => {
                        warn!(phone = %device.name, error = ?result.error, "Quiet cycle: screen power failed");
                        false
                    }
                    None if locals.contains(&device.serial) => {
                        match state
                            .inner
                            .sessions
                            .set_display_power(&device.serial, !screen_off)
                            .await
                        {
                            Ok(()) => true,
                            Err(error) => {
                                warn!(phone = %device.name, %error, "Quiet cycle: screen power failed");
                                false
                            }
                        }
                    }
                    // A phone on another host reports for itself; no report means nothing changed there.
                    None => true,
                },
            };
            screen_out.insert(device.serial.clone(), ok);
        }
    }
    (audio_out, screen_out)
}

/// Apply the current phase to every online phone that does not have it yet. Each phone has
/// its own record: only the operation that failed is retried, and one phone's failure never
/// holds back another. Sound is muted once per run and stays muted in both phases; only the
/// screen changes between them.
pub async fn reconcile(state: &AppState) {
    // One round at a time, and never while the restore for turning the loop off is running.
    let _ops = runtime().ops.lock().await;
    let status = status();
    if !status.cycle.enabled {
        return;
    }
    let (run_id, phase_started, phase) = (
        status.cycle.run_id,
        status.cycle.phase_started_ms,
        status.cycle.phase,
    );
    let devices = state.list_devices().await;
    let online: Vec<&Device> = devices
        .iter()
        .filter(|d| d.status == DeviceStatus::Online)
        .collect();
    let serials: Vec<String> = online.iter().map(|d| d.serial.clone()).collect();
    let (audio_todo, screen_todo) = {
        let mut applied = lock(&runtime().applied);
        // A phone that went away is looked at again when it returns, as a new phone.
        applied.retain(|serial, _| serials.contains(serial));
        let todo = pending(&serials, &applied, run_id, phase_started);
        plan(&todo, &applied, run_id, phase_started)
    };
    if audio_todo.is_empty() && screen_todo.is_empty() {
        return;
    }
    let gens_then = lock(&runtime().gens).clone();
    let (audio_out, screen_out) = run_group(
        state,
        &online,
        &audio_todo,
        &screen_todo,
        true,
        phase == Phase::Quiet,
    )
    .await;

    let mut applied = lock(&runtime().applied);
    // The loop may have been stopped or restarted while the calls ran.
    let phase_started_now = {
        let now = lock(&runtime().cycle);
        if !now.enabled || now.run_id != run_id {
            return;
        }
        now.phase_started_ms
    };
    let gens_now = lock(&runtime().gens).clone();
    settle(
        &mut applied,
        &gens_then,
        &gens_now,
        run_id,
        phase_started,
        phase_started_now,
        &audio_out,
        &screen_out,
    );
}
