//! Macro task queue and scheduler on the agent (port of
//! `src/lib/macro/automation.ts`). Both read the shared store (`macros`,
//! `macro-queue`, `macro-schedules`) and play tabs through the agent's macro
//! runner, so they work with no browser open and never double-fire when
//! several browsers are open.

use crate::device_manager::AppState;
use crate::macro_runner::{self, now_ms, MacroTab, OnlineCheck, RunDevice, RunSnapshot, SendResult, Sender, Size};
use crate::shared_store;
use phonecontrol_protocol::{ControlMode, DeviceStatus, GestureRequest, InjectStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/* ------------------------- runs → gestures ------------------------- */

/// Sends macro steps through the same path as POST /api/input/gesture.
pub fn gesture_sender(state: AppState) -> Sender {
    Arc::new(move |devices: Vec<RunDevice>, strokes| {
        let state = state.clone();
        Box::pin(async move {
            let ids: Vec<String> = devices.iter().map(|d| d.id.clone()).collect();
            let mode = if ids.len() > 1 { ControlMode::Multi } else { ControlMode::Selected };
            match state.handle_gesture(GestureRequest { mode, target_ids: ids.clone(), strokes }).await {
                Ok(result) => devices
                    .iter()
                    .map(|d| match result.targets.iter().find(|t| t.device_id == d.id) {
                        Some(t) => SendResult {
                            device_id: d.id.clone(),
                            inject: match t.inject {
                                InjectStatus::Ok => "ok",
                                InjectStatus::Stub => "stub",
                                InjectStatus::Error => "error",
                            }
                            .into(),
                            detail: t.detail.clone(),
                        },
                        None => SendResult { device_id: d.id.clone(), inject: "error".into(), detail: Some("no result from agent".into()) },
                    })
                    .collect(),
                Err(error) => devices
                    .iter()
                    .map(|d| SendResult { device_id: d.id.clone(), inject: "error".into(), detail: Some(error.clone()) })
                    .collect(),
            }
        })
    })
}

/// The agent's devices for `ids` (unknown ids are dropped).
pub async fn run_devices(state: &AppState, ids: &[String]) -> Vec<RunDevice> {
    let all = state.list_devices().await;
    ids.iter()
        .filter_map(|id| all.iter().find(|d| &d.id == id))
        .map(|d| RunDevice {
            id: d.id.clone(),
            name: d.name.clone(),
            online: d.status == DeviceStatus::Online,
            resolution: Size { width: d.resolution.width as f64, height: d.resolution.height as f64 },
        })
        .collect()
}

/// Asks the agent's device list whether a phone is still connected.
pub fn online_check(state: AppState) -> OnlineCheck {
    Arc::new(move |id: String| {
        let state = state.clone();
        Box::pin(async move { state.list_devices().await.iter().any(|d| d.id == id && d.status == DeviceStatus::Online) })
    })
}

/// Start `tab` on `device_ids` (the tab's own phones when empty): one run per
/// phone, skipping phones that are offline or already running. Returns the
/// phones started.
pub async fn start_tab(state: &AppState, tab: MacroTab, device_ids: Vec<String>, only_step_id: Option<String>) -> Result<macro_runner::StartReport, String> {
    let ids = if device_ids.is_empty() { tab.target_ids.clone() } else { device_ids };
    let devices = run_devices(state, &ids).await;
    macro_runner::runs().start(tab, devices, only_step_id, gesture_sender(state.clone()), Some(online_check(state.clone())))
}

/// Phone → tab id chosen in the Phones card (shared store `macro-assignments`).
pub fn assignments() -> BTreeMap<String, String> {
    let stored = shared_store::store().get("macro-assignments").map(|s| s.value).unwrap_or(Value::Null);
    serde_json::from_value::<BTreeMap<String, Value>>(stored)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(device, tab)| tab.as_str().filter(|t| !t.is_empty()).map(|t| (device, t.to_string())))
        .collect()
}

#[derive(Debug, PartialEq)]
pub enum DeviceStartError {
    UnknownDevice,
    Offline(String),
    NoMacro(String),
    Busy(String),
}

/// Start one phone: `tab` when given, else the tab assigned to it in the shared macros.
pub async fn start_device(state: &AppState, device_id: &str, tab: Option<MacroTab>, only_step_id: Option<String>) -> Result<RunSnapshot, DeviceStartError> {
    let device = run_devices(state, &[device_id.to_string()]).await.into_iter().next().ok_or(DeviceStartError::UnknownDevice)?;
    if !device.online {
        return Err(DeviceStartError::Offline(format!("{} is offline", device.name)));
    }
    let tab = match tab {
        Some(tab) => tab,
        None => {
            let Some(tab_id) = assignments().get(device_id).cloned() else {
                return Err(DeviceStartError::NoMacro(format!("Choose a macro for {} first", device.name)));
            };
            workspace_tabs()
                .into_iter()
                .find(|t| t.id == tab_id)
                .ok_or_else(|| DeviceStartError::NoMacro(format!("The macro chosen for {} was deleted", device.name)))?
        }
    };
    let runs = macro_runner::runs();
    runs.start_device(tab, device, only_step_id, gesture_sender(state.clone()), Some(online_check(state.clone())))
        .map_err(DeviceStartError::Busy)?;
    Ok(runs.view().runs.into_iter().find(|r| r.device_id == device_id).expect("just started"))
}

/// One outcome for a tab played on several phones.
fn combine(results: &[RunSnapshot]) -> ItemState {
    if results.is_empty() {
        return ItemState { state: "failed".into(), detail: None };
    }
    let state = if results.iter().any(|r| r.status == "done") {
        "done"
    } else if results.iter().any(|r| r.status == "stopped") {
        "stopped"
    } else {
        "failed"
    };
    let notes: Vec<String> = results
        .iter()
        .filter(|r| r.status != "done" || results.len() == 1)
        .filter_map(|r| r.message.as_ref().map(|m| if results.len() == 1 { m.clone() } else { format!("{}: {m}", r.device_name) }))
        .collect();
    ItemState { state: state.into(), detail: if notes.is_empty() { results[0].message.clone() } else { Some(notes.join("; ")) } }
}

/* ------------------------------ queue ------------------------------ */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueItem {
    id: String,
    tab_id: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemState {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueProgress {
    pub running: bool,
    pub index: usize,
    pub states: BTreeMap<String, ItemState>,
}

struct QueueRun {
    stop: Arc<AtomicBool>,
    current_tab: Arc<Mutex<Option<String>>>,
}

fn queue_slot() -> &'static Mutex<Option<QueueRun>> {
    static SLOT: OnceLock<Mutex<Option<QueueRun>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn progress_slot() -> &'static Mutex<QueueProgress> {
    static SLOT: OnceLock<Mutex<QueueProgress>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(QueueProgress::default()))
}

pub fn queue_progress() -> QueueProgress {
    progress_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn workspace_tabs() -> Vec<MacroTab> {
    let stored = shared_store::store().get("macros").map(|s| s.value).unwrap_or(Value::Null);
    stored
        .get("tabs")
        .and_then(Value::as_array)
        .map(|tabs| tabs.iter().filter_map(|t| serde_json::from_value::<MacroTab>(t.clone()).ok()).collect())
        .unwrap_or_default()
}

/// A tab from the shared macros.
pub fn shared_tab(tab_id: &str) -> Option<MacroTab> {
    workspace_tabs().into_iter().find(|t| t.id == tab_id)
}

fn queue_items() -> Vec<QueueItem> {
    let stored = shared_store::store().get("macro-queue").map(|s| s.value).unwrap_or(Value::Null);
    serde_json::from_value(stored).unwrap_or_default()
}

/// Play the shared queue once, in order. Err when it is already playing or empty.
pub fn run_queue(state: AppState) -> Result<(), String> {
    let items = queue_items();
    if items.is_empty() {
        return Err("The queue is empty".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let current_tab = Arc::new(Mutex::new(None));
    {
        let mut slot = queue_slot().lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return Err("The queue is already playing".into());
        }
        *slot = Some(QueueRun { stop: stop.clone(), current_tab: current_tab.clone() });
    }
    let set = |change: &dyn Fn(&mut QueueProgress)| {
        let mut p = progress_slot().lock().unwrap_or_else(|e| e.into_inner());
        change(&mut p);
    };
    set(&|p| {
        *p = QueueProgress {
            running: true,
            index: 0,
            states: items.iter().map(|i| (i.id.clone(), ItemState { state: "waiting".into(), detail: None })).collect(),
        }
    });
    tokio::spawn(async move {
        for (index, item) in items.iter().enumerate() {
            set(&|p| p.index = index);
            if stop.load(Ordering::SeqCst) {
                set(&|p| {
                    p.states.insert(item.id.clone(), ItemState { state: "stopped".into(), detail: None });
                });
                continue;
            }
            let Some(tab) = workspace_tabs().into_iter().find(|t| t.id == item.tab_id) else {
                set(&|p| {
                    p.states.insert(item.id.clone(), ItemState { state: "skipped".into(), detail: Some("tab was deleted".into()) });
                });
                continue;
            };
            set(&|p| {
                p.states.insert(item.id.clone(), ItemState { state: "running".into(), detail: None });
            });
            *current_tab.lock().unwrap_or_else(|e| e.into_inner()) = Some(tab.id.clone());
            let outcome = match start_tab(&state, tab, Vec::new(), None).await {
                Err(error) => ItemState { state: "skipped".into(), detail: Some(error) },
                // Next item once every phone of this tab has finished.
                Ok(report) => combine(&macro_runner::runs().wait_devices(&report.started).await),
            };
            set(&|p| {
                p.states.insert(item.id.clone(), outcome.clone());
            });
        }
        set(&|p| p.running = false);
        *queue_slot().lock().unwrap_or_else(|e| e.into_inner()) = None;
    });
    Ok(())
}

/// Stop the tab playing now and skip the rest of the queue.
pub fn stop_queue() -> bool {
    let slot = queue_slot().lock().unwrap_or_else(|e| e.into_inner());
    let Some(run) = slot.as_ref() else { return false };
    run.stop.store(true, Ordering::SeqCst);
    if let Some(tab) = run.current_tab.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        macro_runner::runs().stop(&tab);
    }
    true
}

pub fn queue_running() -> bool {
    queue_slot().lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

/* ---------------------------- scheduler ---------------------------- */

pub const MIN_EVERY_MINUTES: f64 = 1.0;

/// Next time a schedule fires, or None (port of `nextRunAt`).
pub fn next_run_at(schedule: &Value, now: u64) -> Option<u64> {
    if schedule.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let at = schedule.get("at").and_then(Value::as_f64)? as u64;
    let last = schedule.get("lastRunAt").and_then(Value::as_f64).map(|n| n as u64);
    let kind = schedule.get("kind").and_then(Value::as_str).unwrap_or("once");
    if kind != "every" {
        return if last.is_some() { None } else { Some(at) };
    }
    let every_min = schedule.get("everyMinutes").and_then(Value::as_f64).unwrap_or(60.0).max(MIN_EVERY_MINUTES);
    let every = (every_min * 60_000.0) as u64;
    let Some(last) = last.filter(|l| *l >= at) else { return Some(at) };
    let next = at + ((last - at) / every + 1) * every;
    // Slots missed while nothing was running collapse into one run.
    if next + every <= now {
        return Some(at + ((now - at) / every) * every);
    }
    Some(next)
}

/// Fire due schedules once. Returns how many fired.
pub async fn tick(state: &AppState, now: u64) -> usize {
    let store = shared_store::store();
    let Some(stored) = store.get("macro-schedules") else { return 0 };
    let Some(list) = stored.value.as_array().cloned() else { return 0 };
    let mut fired = 0;
    let mut updated = list.clone();
    for (index, schedule) in list.iter().enumerate() {
        let Some(next) = next_run_at(schedule, now) else { continue };
        if next > now {
            continue;
        }
        let target = schedule.get("target").cloned().unwrap_or(Value::Null);
        let result = if target.get("kind").and_then(Value::as_str) == Some("queue") {
            if queue_running() {
                "Skipped: the queue is already playing".to_string()
            } else {
                match run_queue(state.clone()) {
                    Ok(()) => "Started the queue".into(),
                    Err(error) => format!("Skipped: {}", error.to_lowercase()),
                }
            }
        } else {
            let tab_id = target.get("tabId").and_then(Value::as_str).unwrap_or_default().to_string();
            match workspace_tabs().into_iter().find(|t| t.id == tab_id) {
                None => "Skipped: tab was deleted".into(),
                Some(tab) if macro_runner::runs().is_running(&tab.id) => format!("Skipped: “{}” was already running", tab.name),
                Some(tab) => {
                    let devices = run_devices(state, &tab.target_ids).await;
                    if !devices.iter().any(|d| d.online) {
                        format!("Skipped: no online phone ticked in “{}”", tab.name)
                    } else {
                        let name = tab.name.clone();
                        match macro_runner::runs().start(tab, devices, None, gesture_sender(state.clone()), Some(online_check(state.clone()))) {
                            Ok(_) => format!("Started “{name}”"),
                            Err(error) => format!("Skipped: {error}"),
                        }
                    }
                }
            }
        };
        if let Some(obj) = updated[index].as_object_mut() {
            obj.insert("lastRunAt".into(), Value::from(now));
            obj.insert("lastResult".into(), Value::from(result));
        }
        fired += 1;
    }
    if fired > 0 {
        // Record the results; on a concurrent browser edit, merge onto the newer copy.
        if let Err(shared_store::PutError::Conflict(current)) = store.put("macro-schedules", Value::Array(updated.clone()), stored.rev) {
            if let Some(mut fresh) = current.value.as_array().cloned() {
                for done in updated.iter().filter(|s| s.get("lastRunAt").and_then(Value::as_u64) == Some(now)) {
                    let id = done.get("id");
                    if let Some(slot) = fresh.iter_mut().find(|s| s.get("id") == id) {
                        if let (Some(obj), Some(src)) = (slot.as_object_mut(), done.as_object()) {
                            obj.insert("lastRunAt".into(), src["lastRunAt"].clone());
                            obj.insert("lastResult".into(), src["lastResult"].clone());
                        }
                    }
                }
                let _ = store.put("macro-schedules", Value::Array(fresh), current.rev);
            }
        }
    }
    fired
}

/// Start the 15 s scheduler loop (once per process).
pub fn spawn_scheduler(state: AppState) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            tick(&state, now_ms()).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schedule_times_match_the_browser() {
        let once = json!({"id": "s", "kind": "once", "at": 1_000_000, "everyMinutes": 10, "enabled": true});
        assert_eq!(next_run_at(&once, 0), Some(1_000_000));
        let mut done = once.clone();
        done["lastRunAt"] = json!(1_000_100);
        assert_eq!(next_run_at(&done, 2_000_000), None);
        let mut off = once.clone();
        off["enabled"] = json!(false);
        assert_eq!(next_run_at(&off, 0), None);

        let ten = 600_000u64;
        let every = json!({"id": "e", "kind": "every", "at": 1_000_000, "everyMinutes": 10, "enabled": true, "lastRunAt": 1_000_500});
        assert_eq!(next_run_at(&every, 1_000_600), Some(1_000_000 + ten));
        // Closed for an hour: one run at the latest slot.
        assert_eq!(next_run_at(&every, 1_000_000 + 6 * ten + 1000), Some(1_000_000 + 6 * ten));
    }
}
