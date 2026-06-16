use crate::app_config::{
    CONTROLLER_CONNECTED_SOUND, CONTROLLER_DISCONNECTED_SOUND, CONTROLLER_LOW_BATTERY_SOUND,
    LOW_BATTERY_THRESHOLD_PERCENT, SOFTWARE_SETTINGS_FILE_NAME,
};
use crate::hid::{
    collect_supported_devices, devices_snapshot, error_to_string, open_device_by_path,
    HidDeviceInfoDto,
};
use crate::ns2pro_winusb::{find_present_ns2pro_output_paths, Ns2ProWinUsbDevice};
use crate::serial_ns2pro::{has_serial_companion_for_pico_path, Ns2ProSerialBridge};
use crate::state::{
    DeviceMonitorState, Ns2ProAutoDetectState, Ns2ProPicoBridgeState, Ns2ProPicoBridgeStats,
    TrayState,
};
use hidapi::HidApi;
use rodio::{Decoder, OutputStream, Sink};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct SoftwareSettings {
    autostart_enabled: bool,
    start_minimized: bool,
    ns2pro_auto_detect_enabled: bool,
    close_to_tray: bool,
    close_to_tray_asked: bool,
    low_battery_notification_enabled: bool,
    controller_connection_popup_enabled: bool,
    controller_low_battery_popup_enabled: bool,
    controller_notification_popup_duration_ms: u64,
    controller_notification_sound_enabled: bool,
    controller_notification_sound_volumes: ControllerNotificationSoundVolumes,
}

impl Default for SoftwareSettings {
    fn default() -> Self {
        Self {
            autostart_enabled: false,
            start_minimized: false,
            ns2pro_auto_detect_enabled: false,
            close_to_tray: false,
            close_to_tray_asked: false,
            low_battery_notification_enabled: true,
            controller_connection_popup_enabled: true,
            controller_low_battery_popup_enabled: true,
            controller_notification_popup_duration_ms: 4_000,
            controller_notification_sound_enabled: true,
            controller_notification_sound_volumes: ControllerNotificationSoundVolumes::default(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerNotificationSoundVolumes {
    connected: f32,
    disconnected: f32,
    low_battery: f32,
}

impl Default for ControllerNotificationSoundVolumes {
    fn default() -> Self {
        Self {
            connected: 0.65,
            disconnected: 0.65,
            low_battery: 0.75,
        }
    }
}

impl ControllerNotificationSoundVolumes {
    fn normalized(self) -> Self {
        Self {
            connected: normalize_volume(self.connected),
            disconnected: normalize_volume(self.disconnected),
            low_battery: normalize_volume(self.low_battery),
        }
    }

    fn volume_for(&self, sound: &ControllerNotificationSound) -> f32 {
        match sound {
            ControllerNotificationSound::Connected => self.connected,
            ControllerNotificationSound::Disconnected => self.disconnected,
            ControllerNotificationSound::LowBattery => self.low_battery,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareSettingsDto {
    pub autostart_enabled: bool,
    pub start_minimized: bool,
    pub ns2pro_auto_detect_enabled: bool,
    pub close_to_tray: bool,
    pub close_to_tray_asked: bool,
    pub low_battery_notification_enabled: bool,
    pub controller_connection_popup_enabled: bool,
    pub controller_low_battery_popup_enabled: bool,
    pub controller_notification_popup_duration_ms: u64,
    pub controller_notification_sound_enabled: bool,
    pub controller_notification_sound_volumes: ControllerNotificationSoundVolumes,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfoDto {
    os: String,
    arch: String,
}

const NINTENDO_VENDOR_ID: u16 = 0x057e;
const NS2PRO_PRODUCT_ID: u16 = 0x2069;
const SONY_VENDOR_ID: u16 = 0x054c;
const DUALSENSE_PRODUCT_ID: u16 = 0x0ce6;
const DUALSENSE_EDGE_PRODUCT_ID: u16 = 0x0df2;
const PICO_MANAGER_VENDOR_ID: u16 = 0x2e8a;
const PICO_MANAGER_PRODUCT_ID: u16 = 0x00d5;
const PICO_COMMAND_REPORT_ID: u8 = 0xf6;
const PICO_CMD_PREPARE_DUALSENSE_RUNTIME: u8 = 0x04;
const NS2PRO_INPUT_REPORT_ID: u8 = 0x05;
const NS2PRO_MIN_PAYLOAD_LEN: usize = 0x3c;
const NS2PRO_MAX_PAYLOAD_LEN: usize = 64;
const NS2PRO_PICO_MAX_CONSECUTIVE_WRITE_ERRORS: u32 = 30;
const NS2PRO_MAX_CONSECUTIVE_READ_ERRORS: u32 = 30;
const NS2PRO_MAX_IDLE_READS: u32 = 3_000;
const NS2PRO_INPUT_DRAIN_READ_LIMIT: usize = 16;
const NS2PRO_WAIT_DEVICE_RETRY_MS: u64 = 500;
const NS2PRO_SERIAL_WRITE_ERROR_LIMIT: u32 = 16;
const NS2PRO_SERIAL_REOPEN_RETRY_MS: u64 = 1_000;
const NS2PRO_BRIDGE_RESTART_WAIT_MS: u64 = 1_200;
const NS2PRO_MANUAL_PAIRING_WINDOW_MS: u64 = 5_000;
const NS2PRO_WIRED_INIT_RETRY_DELAY_MS: u64 = 2_000;
const PICO_RUNTIME_PREPARE_REENUMERATE_WAIT_MS: u64 = 6_000;
const NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS: u64 = 1;
const NS2PRO_WIRED_INIT_STEP_LONG_DELAY_MS: u64 = 100;

struct Ns2ProWiredInitStep {
    bytes: &'static [u8],
    delay_after_ms: u64,
}

const NS2PRO_WIRED_INIT_STEPS: &[Ns2ProWiredInitStep] = &[
    Ns2ProWiredInitStep { bytes: &[0x02, 0x91, 0x00, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x02, 0x91, 0x00, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x30, 0x01, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x02, 0x91, 0x00, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x30, 0x01, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x02, 0x91, 0x00, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x30, 0x01, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x02, 0x91, 0x00, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x31, 0x01, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x02, 0x91, 0x00, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0xC0, 0x1F, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x02, 0x91, 0x00, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0xC0, 0x1F, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x07, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x0C, 0x91, 0x00, 0x02, 0x00, 0x04, 0x00, 0x00, 0x27, 0x00, 0x00, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_LONG_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x11, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x0A, 0x91, 0x00, 0x08, 0x00, 0x14, 0x00, 0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x35, 0x00, 0x46, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x0C, 0x91, 0x00, 0x04, 0x00, 0x04, 0x00, 0x00, 0x27, 0x00, 0x00, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x01, 0x91, 0x00, 0x0C, 0x00, 0x00, 0x00, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x01, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x08, 0x91, 0x00, 0x02, 0x00, 0x04, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x03, 0x91, 0x00, 0x0A, 0x00, 0x04, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
    Ns2ProWiredInitStep { bytes: &[0x03, 0x91, 0x00, 0x0D, 0x00, 0x08, 0x00, 0x00, 0x01, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], delay_after_ms: NS2PRO_WIRED_INIT_STEP_DEFAULT_DELAY_MS },
];
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ns2ProPicoBridgeStatusDto {
    pub running: bool,
    pub pico_path: Option<String>,
    pub ns2pro_path: Option<String>,
    pub ns2pro_output_path: Option<String>,
    pub input_transport: Option<String>,
    pub input_transport_port: Option<String>,
    pub input_transport_error: Option<String>,
    pub waiting_reason: Option<String>,
    pub input_reports_received: u64,
    pub input_reports_forwarded: u64,
    pub output_reports_received: u64,
    pub output_reports_forwarded: u64,
    pub oversized_reports: u64,
    pub write_errors: u64,
    pub read_errors: u64,
    pub last_serial_output_report_len: u32,
    pub last_serial_output_report_head_hex: Option<String>,
    pub last_output_report_len: u32,
    pub last_output_report_head_hex: Option<String>,
    pub last_output_write_len: u32,
    pub last_output_error: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartNs2ProPicoBridgeOptions {
    pub pico_path: Option<String>,
    pub ns2pro_path: Option<String>,
    pub read_timeout_ms: Option<i32>,
}

#[tauri::command]
pub fn ds5_get_system_info() -> SystemInfoDto {
    SystemInfoDto {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[tauri::command]
pub fn ds5_open_main_window(app: AppHandle) {
    crate::open_main_window_from_tray(&app);
}

#[tauri::command]
pub fn ds5_hide_tray_popup(app: AppHandle) {
    crate::hide_tray_popup(&app);
}

#[tauri::command]
pub fn ds5_show_controller_notification(
    app: AppHandle,
    kind: Option<String>,
    device_label: String,
    icon_src: Option<String>,
    battery_text: String,
    battery_texts: Option<Vec<String>>,
) {
    let normalized_battery_texts =
        normalize_controller_notification_batteries(&battery_text, battery_texts);
    crate::show_controller_notification(
        &app,
        crate::ControllerNotificationPayload {
            kind: kind
                .map(|value| value.trim().to_string())
                .filter(|value| {
                    matches!(value.as_str(), "connected" | "disconnected" | "lowBattery")
                })
                .unwrap_or_else(|| "connected".to_string()),
            device_label,
            icon_src: icon_src
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "/svg/ps5-controller-gamepad-seeklogo.svg".to_string()),
            battery_text,
            battery_texts: normalized_battery_texts,
            duration_ms: None,
        },
    );
}

fn normalize_controller_notification_batteries(
    battery_text: &str,
    battery_texts: Option<Vec<String>>,
) -> Vec<String> {
    let values = battery_texts.unwrap_or_default();
    let normalized: Vec<String> = values
        .into_iter()
        .flat_map(|value| split_battery_text(&value))
        .filter(|value| !value.is_empty() && value != "--")
        .collect();

    if !normalized.is_empty() {
        return normalized;
    }

    split_battery_text(battery_text)
        .into_iter()
        .filter(|value| !value.is_empty() && value != "--")
        .collect()
}

fn split_battery_text(value: &str) -> Vec<String> {
    value
        .split(|character| matches!(character, '/' | '|' | '\n' | '\r'))
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

#[tauri::command]
pub fn ds5_hide_controller_notification(app: AppHandle) {
    crate::hide_controller_notification(&app);
}

#[tauri::command]
pub fn ds5_make_controller_notification_input_safe(app: AppHandle) -> Result<(), String> {
    crate::make_controller_notification_input_safe(&app)
}

#[tauri::command]
pub fn ds5_get_tray_batteries(state: State<'_, TrayState>) -> Vec<String> {
    state
        .battery_values
        .lock()
        .map(|values| values.clone())
        .unwrap_or_else(|_| Vec::new())
}

#[tauri::command]
pub fn ds5_quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn ds5_set_autostart_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<SoftwareSettingsDto, String> {
    let autostart_manager = app.autolaunch();

    if enabled {
        autostart_manager
            .enable()
            .map_err(|error| error.to_string())?;
    } else {
        autostart_manager
            .disable()
            .map_err(|error| error.to_string())?;
    }

    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.autostart_enabled = autostart_manager
        .is_enabled()
        .map_err(|error| error.to_string())?;
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings.clone());
    Ok(settings.into())
}

#[tauri::command]
pub async fn ds5_set_start_minimized_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<SoftwareSettingsDto, String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.start_minimized = enabled;
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings.clone());
    Ok(settings.into())
}

#[tauri::command]
pub async fn ds5_get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ds5_set_ns2pro_auto_detect_enabled(
    app: AppHandle,
    auto_detect_state: State<'_, Ns2ProAutoDetectState>,
    bridge_state: State<'_, Ns2ProPicoBridgeState>,
    enabled: bool,
) -> Result<SoftwareSettingsDto, String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.ns2pro_auto_detect_enabled = enabled;
    save_software_settings_async(app.clone(), settings.clone()).await?;

    if enabled {
        start_ns2pro_auto_detect_loop(
            app.clone(),
            Arc::clone(&auto_detect_state.running),
            Arc::clone(&bridge_state.running),
            Arc::clone(&bridge_state.stats),
        );
    } else {
        auto_detect_state.running.store(false, Ordering::SeqCst);
    }

    emit_software_settings_changed(&app, settings.clone());
    Ok(settings.into())
}

#[tauri::command]
pub async fn ds5_get_ns2pro_auto_detect_enabled(app: AppHandle) -> Result<bool, String> {
    Ok(load_software_settings_async(app)
        .await?
        .ns2pro_auto_detect_enabled)
}

#[tauri::command]
pub async fn ds5_list_devices() -> Result<Vec<HidDeviceInfoDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let api = HidApi::new().map_err(error_to_string)?;
        Ok(collect_supported_devices(&api))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn ds5_start_device_monitor(
    app: AppHandle,
    state: State<'_, DeviceMonitorState>,
) -> Result<(), String> {
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }

    let running = Arc::clone(&state.running);
    thread::spawn(move || {
        let mut previous_snapshot = String::new();

        while running.load(Ordering::SeqCst) {
            if let Ok(api) = HidApi::new() {
                let devices = collect_supported_devices(&api);
                let snapshot = devices_snapshot(&devices);

                if snapshot != previous_snapshot {
                    previous_snapshot = snapshot;
                    let _ = app.emit("ds5-devices-changed", devices);
                }
            }

            thread::sleep(Duration::from_millis(1_500));
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn ds5_start_ns2pro_pico_bridge(
    state: State<'_, Ns2ProPicoBridgeState>,
    options: StartNs2ProPicoBridgeOptions,
) -> Result<Ns2ProPicoBridgeStatusDto, String> {
    open_ns2pro_manual_pairing_window(&state);
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return ns2pro_pico_bridge_status(&state, true);
    }

    let running = Arc::clone(&state.running);
    let stats = Arc::clone(&state.stats);
    let read_timeout_ms = options.read_timeout_ms.unwrap_or(1).clamp(0, 1000);
    spawn_ns2pro_pico_bridge_thread(
        running,
        stats,
        Arc::clone(&state.manual_pairing_until),
        true,
        options.pico_path,
        options.ns2pro_path,
        read_timeout_ms,
    );

    ns2pro_pico_bridge_status(&state, true)
}

#[tauri::command]
pub async fn ds5_restart_ns2pro_pico_bridge(
    state: State<'_, Ns2ProPicoBridgeState>,
    options: StartNs2ProPicoBridgeOptions,
) -> Result<Ns2ProPicoBridgeStatusDto, String> {
    open_ns2pro_manual_pairing_window(&state);
    state.running.store(false, Ordering::SeqCst);
    let wait_started = Instant::now();
    while state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if wait_started.elapsed() >= Duration::from_millis(NS2PRO_BRIDGE_RESTART_WAIT_MS) {
            return ns2pro_pico_bridge_status(&state, true);
        }
        thread::sleep(Duration::from_millis(25));
    }

    scan_ns2pro_serial_once(&state.stats);
    let running = Arc::clone(&state.running);
    let stats = Arc::clone(&state.stats);
    let read_timeout_ms = options.read_timeout_ms.unwrap_or(1).clamp(0, 1000);
    spawn_ns2pro_pico_bridge_thread(
        running,
        stats,
        Arc::clone(&state.manual_pairing_until),
        true,
        options.pico_path,
        options.ns2pro_path,
        read_timeout_ms,
    );

    ns2pro_pico_bridge_status(&state, true)
}

#[tauri::command]
pub async fn ds5_restart_ns2pro_pico_bridge_wired(
    state: State<'_, Ns2ProPicoBridgeState>,
    options: StartNs2ProPicoBridgeOptions,
) -> Result<Ns2ProPicoBridgeStatusDto, String> {
    close_ns2pro_manual_pairing_window(&state);
    state.running.store(false, Ordering::SeqCst);
    let wait_started = Instant::now();
    while state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if wait_started.elapsed() >= Duration::from_millis(NS2PRO_BRIDGE_RESTART_WAIT_MS) {
            return ns2pro_pico_bridge_status(&state, true);
        }
        thread::sleep(Duration::from_millis(25));
    }

    scan_ns2pro_serial_once(&state.stats);
    let running = Arc::clone(&state.running);
    let stats = Arc::clone(&state.stats);
    let read_timeout_ms = options.read_timeout_ms.unwrap_or(1).clamp(0, 1000);
    spawn_ns2pro_pico_bridge_thread(
        running,
        stats,
        Arc::clone(&state.manual_pairing_until),
        false,
        options.pico_path,
        options.ns2pro_path,
        read_timeout_ms,
    );

    ns2pro_pico_bridge_status(&state, true)
}

#[tauri::command]
pub fn ds5_stop_ns2pro_pico_bridge(
    state: State<'_, Ns2ProPicoBridgeState>,
) -> Result<Ns2ProPicoBridgeStatusDto, String> {
    state.running.store(false, Ordering::SeqCst);
    {
        let mut bridge_stats = state.stats.lock().map_err(|error| error.to_string())?;
        bridge_stats.running = false;
    }
    close_ns2pro_manual_pairing_window(&state);
    ns2pro_pico_bridge_status(&state, false)
}

#[tauri::command]
pub async fn ds5_get_ns2pro_pico_bridge_status(
    app: AppHandle,
    state: State<'_, Ns2ProPicoBridgeState>,
) -> Result<Ns2ProPicoBridgeStatusDto, String> {
    let running = Arc::clone(&state.running);
    let stats = Arc::clone(&state.stats);
    let manual_pairing_until = Arc::clone(&state.manual_pairing_until);
    tauri::async_runtime::spawn_blocking(move || {
        let auto_detect_scan_enabled = load_software_settings(&app)
            .map(|settings| settings.ns2pro_auto_detect_enabled)
            .unwrap_or(false);
        let manual_pairing_active = ns2pro_manual_pairing_active(&manual_pairing_until);
        let should_scan_ns2pro = auto_detect_scan_enabled
            || (manual_pairing_active
                && stats
                    .lock()
                    .map(|stats| should_keep_manual_ns2pro_scan(&stats))
                    .unwrap_or(false));
        ns2pro_pico_bridge_status_from_parts(&running, &stats, should_scan_ns2pro)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn ds5_scan_ns2pro_serial_once(
    state: State<'_, Ns2ProPicoBridgeState>,
) -> Result<Ns2ProPicoBridgeStatusDto, String> {
    scan_ns2pro_serial_once(&state.stats);
    ns2pro_pico_bridge_status(&state, true)
}

fn ns2pro_pico_bridge_status(
    state: &State<'_, Ns2ProPicoBridgeState>,
    scan_ns2pro: bool,
) -> Result<Ns2ProPicoBridgeStatusDto, String> {
    ns2pro_pico_bridge_status_from_parts(&state.running, &state.stats, scan_ns2pro)
}

fn ns2pro_pico_bridge_status_from_parts(
    running: &Arc<AtomicBool>,
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    scan_ns2pro: bool,
) -> Result<Ns2ProPicoBridgeStatusDto, String> {
    if !running.load(Ordering::SeqCst) {
        refresh_ns2pro_detection_status(stats, scan_ns2pro);
    }

    let mut bridge_stats = stats.lock().map_err(|error| error.to_string())?;
    bridge_stats.running = running.load(Ordering::SeqCst);
    Ok(Ns2ProPicoBridgeStatusDto::from(bridge_stats.clone()))
}

pub fn scan_ns2pro_serial_once(stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>) {
    match PicoInputTransport::open_serial_preferred() {
        Ok(transport) => set_pico_input_transport_stats(stats, &transport, None),
        Err(error) => {
            let transport = PicoInputTransport::Disabled;
            set_pico_input_transport_stats(stats, &transport, Some(error));
        }
    }
}

fn open_ns2pro_manual_pairing_window(state: &State<'_, Ns2ProPicoBridgeState>) {
    if let Ok(mut until) = state.manual_pairing_until.lock() {
        *until = Some(Instant::now() + Duration::from_millis(NS2PRO_MANUAL_PAIRING_WINDOW_MS));
    }
}

fn close_ns2pro_manual_pairing_window(state: &State<'_, Ns2ProPicoBridgeState>) {
    close_ns2pro_manual_pairing_window_raw(&state.manual_pairing_until);
}

fn close_ns2pro_manual_pairing_window_raw(
    manual_pairing_until: &Arc<std::sync::Mutex<Option<Instant>>>,
) {
    if let Ok(mut until) = manual_pairing_until.lock() {
        *until = None;
    }
}

fn ns2pro_manual_pairing_active(
    manual_pairing_until: &Arc<std::sync::Mutex<Option<Instant>>>,
) -> bool {
    manual_pairing_until
        .lock()
        .map(|until| until.map(|deadline| Instant::now() <= deadline).unwrap_or(false))
        .unwrap_or(false)
}

fn ns2pro_manual_pairing_deadline(
    manual_pairing_until: &Arc<std::sync::Mutex<Option<Instant>>>,
) -> Option<Instant> {
    manual_pairing_until.lock().ok().and_then(|until| *until)
}

fn spawn_ns2pro_pico_bridge_thread(
    running: Arc<AtomicBool>,
    stats: Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    manual_pairing_until: Arc<std::sync::Mutex<Option<Instant>>>,
    manual_pairing_limited: bool,
    pico_path: Option<String>,
    ns2pro_path: Option<String>,
    read_timeout_ms: i32,
) {
    {
        update_ns2pro_pico_bridge_stats(&stats, |bridge_stats| {
            *bridge_stats = Ns2ProPicoBridgeStats {
                running: true,
                pico_path: pico_path.clone(),
                ns2pro_path: ns2pro_path.clone(),
                ns2pro_output_path: ns2pro_path.clone(),
                input_transport: None,
                input_transport_port: None,
                input_transport_error: None,
                ..Ns2ProPicoBridgeStats::default()
            };
        });
    }

    thread::spawn(move || {
        let result = run_ns2pro_pico_bridge_loop(
            &running,
            &stats,
            manual_pairing_limited
                .then(|| ns2pro_manual_pairing_deadline(&manual_pairing_until))
                .flatten(),
            pico_path,
            ns2pro_path,
            read_timeout_ms,
        );

        if let Err(error) = result {
            update_ns2pro_pico_bridge_stats(&stats, |bridge_stats| {
                bridge_stats.last_error = Some(error);
            });
        }

        running.store(false, Ordering::SeqCst);
        update_ns2pro_pico_bridge_stats(&stats, |bridge_stats| {
            bridge_stats.running = false;
            if ns2pro_manual_pairing_active(&manual_pairing_until) {
                if let Ok(api) = HidApi::new() {
                bridge_stats.pico_path = find_first_supported_pico_path(&api);
                bridge_stats.ns2pro_path = find_first_ns2pro_input_path(&api);
                bridge_stats.ns2pro_output_path =
                    find_first_ns2pro_output_path(&api, bridge_stats.ns2pro_path.as_deref());
                } else {
                    bridge_stats.pico_path = None;
                    bridge_stats.ns2pro_path = None;
                    bridge_stats.ns2pro_output_path = None;
                }
            } else {
                bridge_stats.pico_path = None;
                bridge_stats.ns2pro_path = None;
                bridge_stats.ns2pro_output_path = None;
            }
            if bridge_stats.ns2pro_path.is_none() {
                bridge_stats.input_reports_received = 0;
                bridge_stats.input_reports_forwarded = 0;
                bridge_stats.output_reports_received = 0;
                bridge_stats.output_reports_forwarded = 0;
                bridge_stats.oversized_reports = 0;
                bridge_stats.write_errors = 0;
                bridge_stats.read_errors = 0;
            }
            if bridge_stats.last_error.is_none() {
                bridge_stats.input_transport = None;
                bridge_stats.input_transport_port = None;
                bridge_stats.input_transport_error = None;
                bridge_stats.waiting_reason = match (
                    bridge_stats.pico_path.as_deref(),
                    bridge_stats.ns2pro_path.as_deref(),
                ) {
                    (None, Some(_)) => Some("waitingPico".to_string()),
                    (Some(_), Some(_)) => Some("waitingNs2ProBridgeStart".to_string()),
                    _ => None,
                };
            }
        });
        if manual_pairing_limited {
            close_ns2pro_manual_pairing_window_raw(&manual_pairing_until);
        }
    });
}

fn start_ns2pro_auto_detect_loop(
    app: AppHandle,
    auto_detect_running: Arc<AtomicBool>,
    bridge_running: Arc<AtomicBool>,
    bridge_stats: Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
) {
    if auto_detect_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    thread::spawn(move || {
        while auto_detect_running.load(Ordering::SeqCst) {
            if !load_software_settings(&app)
                .map(|settings| settings.ns2pro_auto_detect_enabled)
                .unwrap_or(false)
            {
                auto_detect_running.store(false, Ordering::SeqCst);
                break;
            }

            if bridge_running.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(1_000));
                continue;
            }

            if let Ok(api) = HidApi::new() {
                let ds5_connected = collect_supported_devices(&api).iter().any(|device| {
                    device.vendor_id == SONY_VENDOR_ID
                        && (device.product_id == DUALSENSE_PRODUCT_ID
                            || device.product_id == DUALSENSE_EDGE_PRODUCT_ID)
                        && device.interface_number == 3
                        && device.usage_page == 1
                });
                if ds5_connected {
                    update_ns2pro_detection_status(&bridge_stats, None, None, None);
                    thread::sleep(Duration::from_millis(1_500));
                    continue;
                }
            }

            let next_pair = HidApi::new().ok().and_then(|api| {
                let pico_path = find_first_supported_pico_path(&api);
                let ns2pro_path = find_first_ns2pro_input_path(&api);
                let ns2pro_output_path =
                    find_first_ns2pro_output_path(&api, ns2pro_path.as_deref());
                update_ns2pro_detection_status(
                    &bridge_stats,
                    pico_path.clone(),
                    ns2pro_path.clone(),
                    ns2pro_output_path,
                );
                Some((pico_path, ns2pro_path?))
            });

            if let Some((pico_path, ns2pro_path)) = next_pair {
                if bridge_running
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    spawn_ns2pro_pico_bridge_thread(
                        Arc::clone(&bridge_running),
                        Arc::clone(&bridge_stats),
                        Arc::new(std::sync::Mutex::new(None)),
                        false,
                        pico_path,
                        Some(ns2pro_path),
                        1,
                    );
                }
            }

            thread::sleep(Duration::from_millis(1_500));
        }
    });
}

fn refresh_ns2pro_detection_status(
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    scan_ns2pro: bool,
) {
    if !scan_ns2pro {
        update_ns2pro_detection_status(stats, None, None, None);
        return;
    }

    let paths = HidApi::new().ok().map(|api| {
        let ns2pro_path = find_first_ns2pro_input_path(&api);
        (
            find_first_supported_pico_path(&api),
            ns2pro_path.clone(),
            find_first_ns2pro_output_path(&api, ns2pro_path.as_deref()),
        )
    });
    match paths {
        Some((pico_path, ns2pro_path, ns2pro_output_path)) => {
            update_ns2pro_detection_status(stats, pico_path, ns2pro_path, ns2pro_output_path)
        }
        None => update_ns2pro_detection_status(stats, None, None, None),
    }
}

fn update_ns2pro_detection_status(
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    pico_path: Option<String>,
    ns2pro_path: Option<String>,
    ns2pro_output_path: Option<String>,
) {
    update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
        if bridge_stats.running {
            return;
        }

        bridge_stats.pico_path = pico_path;
        bridge_stats.ns2pro_path = ns2pro_path;
        bridge_stats.ns2pro_output_path = ns2pro_output_path;
        if bridge_stats.ns2pro_path.is_none() {
            bridge_stats.input_reports_received = 0;
            bridge_stats.input_reports_forwarded = 0;
            bridge_stats.output_reports_received = 0;
            bridge_stats.output_reports_forwarded = 0;
            bridge_stats.oversized_reports = 0;
            bridge_stats.write_errors = 0;
            bridge_stats.read_errors = 0;
        }
        bridge_stats.waiting_reason = match (
            bridge_stats.pico_path.as_deref(),
            bridge_stats.ns2pro_path.as_deref(),
        ) {
            (None, Some(_)) => Some("waitingPico".to_string()),
            (Some(_), Some(_)) => Some("waitingNs2ProBridgeStart".to_string()),
            _ => None,
        };
        bridge_stats.last_error = None;
    });
}

fn should_keep_manual_ns2pro_scan(stats: &Ns2ProPicoBridgeStats) -> bool {
    if stats.running {
        return true;
    }

    if stats.pico_path.is_some() || stats.ns2pro_path.is_some() {
        return true;
    }

    if stats.input_reports_received > 0
        || stats.input_reports_forwarded > 0
        || stats.output_reports_received > 0
        || stats.output_reports_forwarded > 0
    {
        return true;
    }

    matches!(
        stats.waiting_reason.as_deref(),
        Some(
            "waitingPico"
                | "waitingNs2Pro"
                | "waitingNs2ProBridgeStart"
                | "waitingInput"
                | "waitingForwarding"
                | "waitingDualSenseReconnect"
                | "forwarding"
                | "inputReceiveFailed"
                | "inputForwardFailed"
                | "outputForwardFailed"
        )
    ) || stats.last_error.is_some()
}

fn ns2pro_bridge_waiting_reason(
    running: bool,
    pico_path: Option<&str>,
    ns2pro_path: Option<&str>,
    _input_reports_received: u64,
    _input_reports_forwarded: u64,
) -> String {
    if !running {
        return "inactive".to_string();
    }

    if pico_path.is_none() {
        return "waitingPico".to_string();
    }

    if ns2pro_path.is_none() {
        return "waitingNs2Pro".to_string();
    }

    "forwarding".to_string()
}

pub fn start_ns2pro_auto_detect_if_enabled(
    app: AppHandle,
    auto_detect_state: tauri::State<'_, Ns2ProAutoDetectState>,
    bridge_state: tauri::State<'_, Ns2ProPicoBridgeState>,
) {
    if load_software_settings(&app)
        .map(|settings| settings.ns2pro_auto_detect_enabled)
        .unwrap_or(false)
    {
        start_ns2pro_auto_detect_loop(
            app,
            Arc::clone(&auto_detect_state.running),
            Arc::clone(&bridge_state.running),
            Arc::clone(&bridge_state.stats),
        );
    }
}

fn run_ns2pro_pico_bridge_loop(
    running: &Arc<AtomicBool>,
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    manual_pairing_deadline: Option<Instant>,
    pico_path: Option<String>,
    ns2pro_path: Option<String>,
    read_timeout_ms: i32,
) -> Result<(), String> {
    let mut pico_input = PicoInputTransport::Disabled;
    set_pico_input_transport_stats(stats, &pico_input, None);

    let (resolved_pico_path, resolved_ns2pro_path) =
        wait_for_ns2pro_bridge_devices(
        running,
        stats,
        manual_pairing_deadline,
        pico_path,
        ns2pro_path,
    )?;

    update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
        bridge_stats.pico_path = Some(resolved_pico_path.clone());
        bridge_stats.ns2pro_path = Some(resolved_ns2pro_path.clone());
        bridge_stats.ns2pro_output_path = Some(resolved_ns2pro_path.clone());
        bridge_stats.waiting_reason = Some("forwarding".to_string());
        bridge_stats.last_error = None;
    });
    match PicoInputTransport::open_serial_for_pico_path(Some(resolved_pico_path.as_str())) {
        Ok(transport) => {
            pico_input = transport;
            set_pico_input_transport_stats(stats, &pico_input, None);
        }
        Err(error) => {
            pico_input = PicoInputTransport::Disabled;
            set_pico_input_transport_stats(stats, &pico_input, Some(error.clone()));
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.waiting_reason = Some("inputForwardFailed".to_string());
                bridge_stats.last_error = Some(error.clone());
            });
        }
    }

    let mut _ns2pro_input_api_guard = HidApi::new().map_err(error_to_string)?;
    let mut current_ns2pro_path = resolved_ns2pro_path;
    let mut ns2pro = match open_ns2pro_input_device_handle(&_ns2pro_input_api_guard, &current_ns2pro_path) {
        Ok(device) => device,
        Err(error) => {
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.waiting_reason = Some("inputReceiveFailed".to_string());
                bridge_stats.last_error = Some(error.clone());
            });
            return Err(error);
        }
    };
    let mut current_ns2pro_output_path = current_ns2pro_path.clone();
    let mut ns2pro_output = None;
    let mut input_buffer = vec![0_u8; 65];
    let mut consecutive_write_errors = 0_u32;
    let mut consecutive_read_errors = 0_u32;
    let mut consecutive_serial_write_errors = 0_u32;
    let mut idle_reads = 0_u32;
    let mut next_serial_reopen_at = Instant::now();
    let mut next_output_reopen_at = Instant::now();
    let bridge_started_at = Instant::now();
    let mut init_confirmed = false;
    let mut init_attempted = false;
    let mut next_init_retry_at = bridge_started_at + Duration::from_millis(NS2PRO_WIRED_INIT_RETRY_DELAY_MS);
    let mut pending_output_report: Option<[u8; 64]> = None;

    while running.load(Ordering::SeqCst) {
        let manual_pairing_expired = manual_pairing_deadline
            .map(|deadline| Instant::now() > deadline)
            .unwrap_or(false);

        if manual_pairing_expired && pico_input.is_disabled() {
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.pico_path = None;
                bridge_stats.waiting_reason = None;
                bridge_stats.input_transport_error = None;
                bridge_stats.last_error = None;
            });
            return Ok(());
        }

        if !manual_pairing_expired {
            reopen_serial_transport_if_needed(
                &mut pico_input,
                stats,
                &mut next_serial_reopen_at,
                Some(resolved_pico_path.as_str()),
            );
        }

        let serial_output_reports = match pico_input.take_pending_output_reports() {
            Ok(reports) => reports,
            Err(error) => {
                update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                    bridge_stats.waiting_reason = Some("outputForwardFailed".to_string());
                    bridge_stats.write_errors = bridge_stats.write_errors.saturating_add(1);
                    bridge_stats.last_error = Some(error);
                });
                Vec::new()
            }
        };

        if !serial_output_reports.is_empty() {
            pending_output_report = serial_output_reports.last().copied();
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.output_reports_received = bridge_stats
                    .output_reports_received
                    .saturating_add(serial_output_reports.len() as u64);
                if let Some(report) = pending_output_report.as_ref() {
                    bridge_stats.last_serial_output_report_len = report.len() as u32;
                    bridge_stats.last_serial_output_report_head_hex = Some(hex_head(report, 12));
                }
            });
        }

        if let Some(report) = pending_output_report.as_ref() {
            if ns2pro_output.is_none() {
                ns2pro_output = try_open_ns2pro_output_device_if_needed(
                    &current_ns2pro_path,
                    &mut current_ns2pro_output_path,
                    stats,
                    &mut next_output_reopen_at,
                );
            }

            if let Some(device) = ns2pro_output.as_mut() {
                if let Err(error) = forward_ns2pro_output_reports(
                    device,
                    &current_ns2pro_output_path,
                    stats,
                    std::slice::from_ref(report),
                ) {
                    update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                        bridge_stats.waiting_reason = Some("outputForwardFailed".to_string());
                        bridge_stats.write_errors = bridge_stats.write_errors.saturating_add(1);
                        bridge_stats.last_error = Some(error);
                    });
                    ns2pro_output = None;
                    next_output_reopen_at = Instant::now();
                } else {
                    pending_output_report = None;
                }
            }
        }

        if !init_confirmed && !init_attempted && Instant::now() >= next_init_retry_at {
            if ns2pro_output.is_none() {
                ns2pro_output = try_open_ns2pro_output_device_if_needed(
                    &current_ns2pro_path,
                    &mut current_ns2pro_output_path,
                    stats,
                    &mut next_output_reopen_at,
                );
            }

            if let Some(device) = ns2pro_output.as_mut() {
                let output_init =
                    device.send_initialization_reports(&current_ns2pro_output_path);
                init_attempted = true;
                update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                    bridge_stats.waiting_reason = Some("forwarding".to_string());
                    if let Err(error) = output_init.as_ref() {
                        bridge_stats.last_error = Some(error.clone());
                    } else {
                        bridge_stats.last_error = None;
                    }
                });
            }
        }

        match ns2pro.read_timeout(&mut input_buffer, read_timeout_ms) {
            Ok(0) => {
                idle_reads = idle_reads.saturating_add(1);
                if idle_reads >= NS2PRO_MAX_IDLE_READS {
                    if let Some(next_path) = current_ns2pro_input_path(&current_ns2pro_path) {
                        if next_path != current_ns2pro_path {
                            if let Ok((next_api, next_device)) = open_ns2pro_input_device(&next_path) {
                                _ns2pro_input_api_guard = next_api;
                                ns2pro = next_device;
                                current_ns2pro_path = next_path;
                                init_confirmed = false;
                                init_attempted = false;
                                next_init_retry_at = Instant::now()
                                    + Duration::from_millis(NS2PRO_WIRED_INIT_RETRY_DELAY_MS);
                                ns2pro_output = None;
                                next_output_reopen_at = Instant::now();
                        }
                        }
                        idle_reads = 0;
                        update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                            bridge_stats.ns2pro_path = Some(current_ns2pro_path.clone());
                            bridge_stats.ns2pro_output_path =
                                Some(current_ns2pro_output_path.clone());
                            bridge_stats.waiting_reason = Some("forwarding".to_string());
                            bridge_stats.last_error = None;
                        });
                        continue;
                    }
                    update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                        bridge_stats.waiting_reason = Some("inputReceiveFailed".to_string());
                        bridge_stats.last_error = Some(
                            "No NS2Pro input reports were received for too long; restarting NS2Pro bridge."
                                .to_string(),
                        );
                    });
                    return Err("No NS2Pro input reports were received for too long; restarting NS2Pro bridge.".to_string());
                }
                continue;
            }
            Ok(count) => {
                consecutive_read_errors = 0;
                idle_reads = 0;
                init_confirmed = true;
                update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                    bridge_stats.input_reports_received =
                        bridge_stats.input_reports_received.saturating_add(1);
                    bridge_stats.waiting_reason = Some("forwarding".to_string());
                });

                let mut latest_payload = [0_u8; NS2PRO_MAX_PAYLOAD_LEN];
                let Some(mut latest_payload_len) =
                    copy_ns2pro_input_payload(&input_buffer, count, &mut latest_payload)
                else {
                    if count > 1
                        && input_buffer.first().copied() == Some(NS2PRO_INPUT_REPORT_ID)
                        && (count - 1) > NS2PRO_MAX_PAYLOAD_LEN
                    {
                        update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                            bridge_stats.oversized_reports =
                                bridge_stats.oversized_reports.saturating_add(1);
                        });
                    }
                    continue;
                };

                for _ in 0..NS2PRO_INPUT_DRAIN_READ_LIMIT {
                    match ns2pro.read_timeout(&mut input_buffer, 0) {
                        Ok(0) => break,
                        Ok(next_count) => {
                            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                                bridge_stats.input_reports_received =
                                    bridge_stats.input_reports_received.saturating_add(1);
                            });
                            match copy_ns2pro_input_payload(&input_buffer, next_count, &mut latest_payload) {
                                Some(next_payload_len) => {
                                    latest_payload_len = next_payload_len;
                                }
                                None => {
                                    if next_count > 1
                                        && input_buffer.first().copied() == Some(NS2PRO_INPUT_REPORT_ID)
                                        && (next_count - 1) > NS2PRO_MAX_PAYLOAD_LEN
                                    {
                                        update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                                            bridge_stats.oversized_reports =
                                                bridge_stats.oversized_reports.saturating_add(1);
                                        });
                                    }
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }

                let payload = &latest_payload[..latest_payload_len];

                if pico_input.is_disabled() {
                    if !manual_pairing_expired {
                        reopen_serial_transport_if_needed(
                            &mut pico_input,
                            stats,
                            &mut next_serial_reopen_at,
                            Some(resolved_pico_path.as_str()),
                        );
                    }
                }

                if pico_input.is_disabled() {
                    if manual_pairing_expired {
                        update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                            bridge_stats.pico_path = None;
                            bridge_stats.waiting_reason = None;
                            bridge_stats.input_transport_error = None;
                            bridge_stats.last_error = None;
                        });
                        return Ok(());
                    }
                    update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                        bridge_stats.waiting_reason = Some("inputForwardFailed".to_string());
                        bridge_stats.input_transport = Some("serial".to_string());
                        bridge_stats.input_transport_error = bridge_stats.input_transport_error
                            .clone()
                            .or_else(|| Some("Serial is unavailable; HID Feature input forwarding is disabled.".to_string()));
                        bridge_stats.last_error = bridge_stats.input_transport_error.clone();
                    });
                    continue;
                }

                match pico_input.send(payload) {
                    Ok(()) => {
                        consecutive_write_errors = 0;
                        consecutive_serial_write_errors = 0;
                        update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                            bridge_stats.input_reports_forwarded =
                                bridge_stats.input_reports_forwarded.saturating_add(1);
                            bridge_stats.waiting_reason = Some("forwarding".to_string());
                            bridge_stats.input_transport_error = None;
                            bridge_stats.last_error = None;
                        });
                        set_pico_input_transport_stats(stats, &pico_input, None);
                    }
                    Err(error) => {
                        let message = error;
                        if matches!(pico_input, PicoInputTransport::Serial(_)) {
                            consecutive_serial_write_errors =
                                consecutive_serial_write_errors.saturating_add(1);
                            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                                bridge_stats.waiting_reason = Some("inputForwardFailed".to_string());
                                bridge_stats.write_errors = bridge_stats.write_errors.saturating_add(1);
                                bridge_stats.last_error = Some(message.clone());
                            });
                            if consecutive_serial_write_errors < NS2PRO_SERIAL_WRITE_ERROR_LIMIT {
                                continue;
                            }
                            pico_input = PicoInputTransport::Disabled;
                            set_pico_input_transport_stats(stats, &pico_input, Some(message.clone()));
                            consecutive_serial_write_errors = 0;
                            next_serial_reopen_at = Instant::now() + Duration::from_millis(NS2PRO_SERIAL_REOPEN_RETRY_MS);
                            continue;
                        }

                        consecutive_write_errors = consecutive_write_errors.saturating_add(1);
                        update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                            bridge_stats.waiting_reason = Some("inputForwardFailed".to_string());
                            bridge_stats.write_errors = bridge_stats.write_errors.saturating_add(1);
                            bridge_stats.last_error = Some(message.clone());
                        });
                        if consecutive_write_errors >= NS2PRO_PICO_MAX_CONSECUTIVE_WRITE_ERRORS {
                            if manual_pairing_expired {
                                return Ok(());
                            }
                            match recover_pico_if_ns2pro_present(&current_ns2pro_path, stats) {
                                PicoRecovery::Found => {
                                    consecutive_write_errors = 0;
                                    continue;
                                }
                                PicoRecovery::WaitingForPico => {
                                    consecutive_write_errors = 0;
                                    thread::sleep(Duration::from_millis(NS2PRO_WAIT_DEVICE_RETRY_MS));
                                    continue;
                                }
                                PicoRecovery::Ns2ProMissing => {}
                            }
                            return Err(format!(
                                "Pico write failed {consecutive_write_errors} times in a row; restarting NS2Pro bridge. Last error: {message}"
                            ));
                        }
                    }
                }
            }
            Err(error) => {
                consecutive_read_errors = consecutive_read_errors.saturating_add(1);
                let message = error_to_string(error);
                update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                    bridge_stats.waiting_reason = Some("inputReceiveFailed".to_string());
                    bridge_stats.read_errors = bridge_stats.read_errors.saturating_add(1);
                    bridge_stats.last_error = Some(message.clone());
                });
                if consecutive_read_errors >= NS2PRO_MAX_CONSECUTIVE_READ_ERRORS {
                        if let Some(next_path) = current_ns2pro_input_path(&current_ns2pro_path) {
                        if let Ok((next_api, next_device)) = open_ns2pro_input_device(&next_path) {
                            _ns2pro_input_api_guard = next_api;
                            ns2pro = next_device;
                            current_ns2pro_path = next_path;
                            consecutive_read_errors = 0;
                            idle_reads = 0;
                            init_confirmed = false;
                            init_attempted = false;
                            next_init_retry_at = Instant::now()
                                + Duration::from_millis(NS2PRO_WIRED_INIT_RETRY_DELAY_MS);
                            ns2pro_output = None;
                            next_output_reopen_at = Instant::now();
                            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                                bridge_stats.ns2pro_path = Some(current_ns2pro_path.clone());
                                bridge_stats.ns2pro_output_path =
                                    Some(current_ns2pro_output_path.clone());
                                bridge_stats.waiting_reason = Some("forwarding".to_string());
                                bridge_stats.last_error = None;
                            });
                            continue;
                        }
                    }
                    return Err(format!(
                        "NS2Pro HID read failed {consecutive_read_errors} times in a row; restarting NS2Pro bridge. Last error: {message}"
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    Ok(())
}

fn reopen_serial_transport_if_needed(
    transport: &mut PicoInputTransport,
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    next_retry_at: &mut Instant,
    pico_path: Option<&str>,
) {
    if !transport.is_disabled() {
        return;
    }

    let now = Instant::now();
    if now < *next_retry_at {
        return;
    }
    *next_retry_at = now + Duration::from_millis(NS2PRO_SERIAL_REOPEN_RETRY_MS);

    match PicoInputTransport::open_serial_for_pico_path(pico_path) {
        Ok(next_transport) => {
            *transport = next_transport;
            set_pico_input_transport_stats(stats, transport, None);
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.last_error = None;
            });
        }
        Err(error) => {
            set_pico_input_transport_stats(stats, transport, Some(error));
        }
    }
}

fn copy_ns2pro_input_payload(
    input_buffer: &[u8],
    count: usize,
    payload: &mut [u8; NS2PRO_MAX_PAYLOAD_LEN],
) -> Option<usize> {
    if count <= 1 || input_buffer.first().copied() != Some(NS2PRO_INPUT_REPORT_ID) {
        return None;
    }

    let payload_len = count - 1;
    if !(NS2PRO_MIN_PAYLOAD_LEN..=NS2PRO_MAX_PAYLOAD_LEN).contains(&payload_len) {
        return None;
    }

    payload[..payload_len].copy_from_slice(&input_buffer[1..count]);
    Some(payload_len)
}

fn hex_head(bytes: &[u8], limit: usize) -> String {
    bytes.iter()
        .take(limit)
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

enum PicoInputTransport {
    Serial(Ns2ProSerialBridge),
    Disabled,
}

impl PicoInputTransport {
    fn open_serial_preferred() -> Result<Self, String> {
        Ns2ProSerialBridge::open_auto().map(Self::Serial)
    }

    fn open_serial_for_pico_path(pico_path: Option<&str>) -> Result<Self, String> {
        Ns2ProSerialBridge::open_for_pico_path(pico_path).map(Self::Serial)
    }

    fn is_disabled(&self) -> bool {
        matches!(self, Self::Disabled)
    }

    fn send(&mut self, payload: &[u8]) -> Result<(), String> {
        match self {
            Self::Serial(serial) => serial.write_ns2pro_report(payload),
            Self::Disabled => Err("Serial is unavailable; HID Feature input forwarding is disabled.".to_string()),
        }
    }

    fn take_pending_output_reports(&mut self) -> Result<Vec<[u8; 64]>, String> {
        let Self::Serial(serial) = self else {
            return Ok(Vec::new());
        };

        serial.read_ns2pro_output_reports()
    }
}

fn forward_ns2pro_output_reports(
    ns2pro: &mut Ns2ProOutputDevice,
    output_path: &str,
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    reports: &[[u8; 64]],
) -> Result<(), String> {
    for report in reports {
        let written = ns2pro.write_report(report).map_err(|error| {
            let message =
                format!("NS2Pro output write failed ({output_path}): {}", error_to_string(error));
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.last_output_report_len = report.len() as u32;
                bridge_stats.last_output_report_head_hex = Some(hex_head(report, 12));
                bridge_stats.last_output_write_len = 0;
                bridge_stats.last_output_error = Some(message.clone());
            });
            message
        })?;
        update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
            bridge_stats.output_reports_forwarded =
                bridge_stats.output_reports_forwarded.saturating_add(1);
            bridge_stats.ns2pro_output_path = Some(output_path.to_string());
            bridge_stats.last_output_report_len = report.len() as u32;
            bridge_stats.last_output_report_head_hex = Some(hex_head(report, 12));
            bridge_stats.last_output_write_len = written as u32;
            bridge_stats.last_output_error = None;
            bridge_stats.last_error = None;
        });
    }

    Ok(())
}

fn set_pico_input_transport_stats(
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    transport: &PicoInputTransport,
    transport_error: Option<String>,
) {
    update_ns2pro_pico_bridge_stats(stats, |bridge_stats| match transport {
        PicoInputTransport::Serial(serial) => {
            bridge_stats.input_transport = Some("serial".to_string());
            bridge_stats.input_transport_port = Some(serial.port_name().to_string());
            bridge_stats.input_transport_error = None;
        }
        PicoInputTransport::Disabled => {
            bridge_stats.input_transport = Some("serial".to_string());
            bridge_stats.input_transport_port = None;
            bridge_stats.input_transport_error = transport_error
                .or_else(|| Some("Serial is unavailable; HID Feature input forwarding is disabled.".to_string()));
        }
    });
}

enum PicoRecovery {
    Found,
    WaitingForPico,
    Ns2ProMissing,
}

fn recover_pico_if_ns2pro_present(
    current_ns2pro_path: &str,
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
) -> PicoRecovery {
    let api = match HidApi::new() {
        Ok(api) => api,
        Err(error) => {
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.waiting_reason = Some("waitingPico".to_string());
                bridge_stats.last_error = Some(error_to_string(error));
            });
            return PicoRecovery::WaitingForPico;
        }
    };

    let ns2pro_path = if ns2pro_input_path_exists(&api, current_ns2pro_path) {
        Some(current_ns2pro_path.to_string())
    } else {
        find_first_ns2pro_input_path(&api)
    };

    let Some(ns2pro_path) = ns2pro_path else {
        update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
            bridge_stats.ns2pro_path = None;
            bridge_stats.ns2pro_output_path = None;
            bridge_stats.waiting_reason = Some("waitingNs2Pro".to_string());
        });
        return PicoRecovery::Ns2ProMissing;
    };

    let ns2pro_output_path = find_first_ns2pro_output_path(&api, Some(ns2pro_path.as_str()))
        .or_else(|| Some(ns2pro_path.clone()));

    let Some(pico_path) = find_first_supported_pico_path(&api) else {
        update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
            bridge_stats.pico_path = None;
            bridge_stats.ns2pro_path = Some(ns2pro_path.clone());
            bridge_stats.ns2pro_output_path = ns2pro_output_path.clone();
            bridge_stats.waiting_reason = Some("waitingPico".to_string());
            bridge_stats.last_error = None;
        });
        return PicoRecovery::WaitingForPico;
    };

    update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
        bridge_stats.pico_path = Some(pico_path);
        bridge_stats.ns2pro_path = Some(ns2pro_path);
        bridge_stats.ns2pro_output_path = ns2pro_output_path;
        bridge_stats.waiting_reason = Some("waitingNs2ProBridgeStart".to_string());
        bridge_stats.last_error = None;
    });
    PicoRecovery::Found
}

fn open_ns2pro_input_device(path: &str) -> Result<(HidApi, hidapi::HidDevice), String> {
    let api = HidApi::new().map_err(error_to_string)?;
    let device = open_ns2pro_input_device_handle(&api, path)?;
    Ok((api, device))
}

fn open_ns2pro_input_device_handle(
    api: &HidApi,
    path: &str,
) -> Result<hidapi::HidDevice, String> {
    open_device_by_path(api, path)
}

fn open_ns2pro_output_device(path: &str) -> Result<Ns2ProOutputDevice, String> {
    Ns2ProOutputDevice::open(path)
}

fn current_ns2pro_input_path(previous_path: &str) -> Option<String> {
    let api = HidApi::new().ok()?;
    if ns2pro_input_path_exists(&api, previous_path) {
        return Some(previous_path.to_string());
    }
    find_first_ns2pro_input_path(&api)
}

fn resolve_ns2pro_input_path(api: &HidApi, preferred_path: Option<&str>) -> Option<String> {
    if let Some(path) = preferred_path.filter(|path| ns2pro_input_path_exists(api, path)) {
        return Some(path.to_string());
    }
    find_first_ns2pro_input_path(api)
}

fn ns2pro_input_path_exists(api: &HidApi, path: &str) -> bool {
    ns2pro_hid_path_exists(api, path)
}

fn wait_for_ns2pro_bridge_devices(
    running: &Arc<AtomicBool>,
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    manual_pairing_deadline: Option<Instant>,
    preferred_pico_path: Option<String>,
    preferred_ns2pro_path: Option<String>,
) -> Result<(String, String), String> {
    let mut last_error: Option<String> = None;
    let prepared_runtime = prepare_pico_runtime_if_needed(preferred_pico_path.as_deref())
        .inspect_err(|error| {
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.waiting_reason = Some("waitingDualSenseReconnect".to_string());
                bridge_stats.last_error = Some(error.clone());
            });
        })?;
    let runtime_deadline = prepared_runtime.then(|| {
        Instant::now() + Duration::from_millis(PICO_RUNTIME_PREPARE_REENUMERATE_WAIT_MS)
    });

    while running.load(Ordering::SeqCst) {
        if manual_pairing_deadline
            .map(|deadline| Instant::now() > deadline)
            .unwrap_or(false)
        {
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.pico_path = None;
                bridge_stats.ns2pro_path = None;
                bridge_stats.ns2pro_output_path = None;
                bridge_stats.waiting_reason = None;
                bridge_stats.last_error = None;
            });
            return Err("NS2Pro manual pairing window expired.".to_string());
        }

        match HidApi::new() {
            Ok(api) => {
                let resolved_ns2pro_path =
                    resolve_ns2pro_input_path(&api, preferred_ns2pro_path.as_deref());
                let waiting_runtime_pico = runtime_deadline
                    .map(|deadline| Instant::now() <= deadline)
                    .unwrap_or(false);
                let resolved_pico_path = if waiting_runtime_pico {
                    find_first_runtime_pico_path(&api, true)
                } else {
                    resolve_supported_pico_path(&api, preferred_pico_path.as_deref())
                };

                update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                    bridge_stats.pico_path = resolved_pico_path.clone();
                    bridge_stats.ns2pro_path = resolved_ns2pro_path.clone();
                    bridge_stats.ns2pro_output_path = resolved_ns2pro_path.clone();
                    bridge_stats.waiting_reason = Some(if waiting_runtime_pico
                        && resolved_pico_path.is_none()
                    {
                        "waitingDualSenseReconnect".to_string()
                    } else {
                        ns2pro_bridge_waiting_reason(
                            bridge_stats.running,
                            resolved_pico_path.as_deref(),
                            resolved_ns2pro_path.as_deref(),
                            bridge_stats.input_reports_received,
                            bridge_stats.input_reports_forwarded,
                        )
                    });
                    bridge_stats.last_error = None;
                });

                if let (Some(pico_path), Some(ns2pro_path)) =
                    (resolved_pico_path, resolved_ns2pro_path)
                {
                    return Ok((pico_path, ns2pro_path));
                }
            }
            Err(error) => {
                let message = error_to_string(error);
                if last_error.as_deref() != Some(message.as_str()) {
                    last_error = Some(message.clone());
                    update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                        bridge_stats.last_error = Some(message);
                    });
                }
            }
        }

        thread::sleep(Duration::from_millis(NS2PRO_WAIT_DEVICE_RETRY_MS));
    }

    Err("NS2Pro bridge was stopped before Pico and NS2Pro were both available.".to_string())
}

fn find_first_supported_pico_path(api: &HidApi) -> Option<String> {
    let devices = collect_supported_devices(api);
    devices
        .iter()
        .find(|device| {
            device.vendor_id == SONY_VENDOR_ID
                && (device.product_id == DUALSENSE_PRODUCT_ID
                    || device.product_id == DUALSENSE_EDGE_PRODUCT_ID)
                && device.interface_number == 3
                && device.usage_page == 1
                && has_serial_companion_for_pico_path(&device.path)
        })
        .or_else(|| {
            devices
                .iter()
                .find(|device| {
                    device.vendor_id == PICO_MANAGER_VENDOR_ID
                        && device.product_id == PICO_MANAGER_PRODUCT_ID
                })
        })
        .or_else(|| {
            devices
                .iter()
                .find(|device| {
                    device.vendor_id == SONY_VENDOR_ID
                        && (device.product_id == DUALSENSE_PRODUCT_ID
                            || device.product_id == DUALSENSE_EDGE_PRODUCT_ID)
                        && device.interface_number == 3
                        && device.usage_page == 1
                })
        })
        .map(|device| device.path.clone())
}

fn resolve_supported_pico_path(api: &HidApi, preferred_path: Option<&str>) -> Option<String> {
    if let Some(path) = preferred_path {
        let devices = collect_supported_devices(api);
        if devices.iter().any(|device| device.path == path) {
            return Some(path.to_string());
        }
    }

    find_first_supported_pico_path(api)
}

fn find_first_runtime_pico_path(api: &HidApi, require_serial_companion: bool) -> Option<String> {
    collect_supported_devices(api)
        .into_iter()
        .find(|device| {
            device.vendor_id == SONY_VENDOR_ID
                && (device.product_id == DUALSENSE_PRODUCT_ID
                    || device.product_id == DUALSENSE_EDGE_PRODUCT_ID)
                && device.interface_number == 3
                && device.usage_page == 1
                && (!require_serial_companion || has_serial_companion_for_pico_path(&device.path))
        })
        .map(|device| device.path)
}

fn prepare_pico_runtime_if_needed(preferred_path: Option<&str>) -> Result<bool, String> {
    let api = HidApi::new().map_err(error_to_string)?;
    let devices = collect_supported_devices(&api);

    let preferred_device = preferred_path.and_then(|path| {
        devices
            .iter()
            .find(|device| device.path == path)
    });

    let runtime_present = devices.iter().any(|device| {
        device.vendor_id == SONY_VENDOR_ID
            && (device.product_id == DUALSENSE_PRODUCT_ID
                || device.product_id == DUALSENSE_EDGE_PRODUCT_ID)
            && device.interface_number == 3
            && device.usage_page == 1
    });

    let manager_path = preferred_device
        .filter(|device| {
            device.vendor_id == PICO_MANAGER_VENDOR_ID
                && device.product_id == PICO_MANAGER_PRODUCT_ID
        })
        .map(|device| device.path.clone())
        .or_else(|| {
            devices
                .iter()
                .find(|device| {
                    device.vendor_id == PICO_MANAGER_VENDOR_ID
                        && device.product_id == PICO_MANAGER_PRODUCT_ID
                })
                .map(|device| device.path.clone())
        });

    let Some(manager_path) = manager_path else {
        return Ok(false);
    };

    if runtime_present {
        return Ok(false);
    }

    let device = open_device_by_path(&api, &manager_path)?;
    let buffer = [PICO_COMMAND_REPORT_ID, PICO_CMD_PREPARE_DUALSENSE_RUNTIME];
    device.send_feature_report(&buffer).map_err(error_to_string)?;
    Ok(true)
}

fn find_first_ns2pro_input_path(api: &HidApi) -> Option<String> {
    ns2pro_hid_candidates(api)
        .into_iter()
        .min_by_key(|device| {
            let usage_page_penalty = if device.usage_page == 1 { 0 } else { 1 };
            (usage_page_penalty, device.interface_number)
        })
        .map(|device| device.path)
}

fn find_first_ns2pro_output_path(api: &HidApi, preferred_input_path: Option<&str>) -> Option<String> {
    if let Some(path) = preferred_input_path.filter(|path| ns2pro_input_path_exists(api, path)) {
        return Some(path.to_string());
    }
    find_first_ns2pro_input_path(api)
}

fn try_open_ns2pro_output_device_if_needed(
    current_ns2pro_input_path: &str,
    current_ns2pro_output_path: &mut String,
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    next_retry_at: &mut Instant,
) -> Option<Ns2ProOutputDevice> {
    let now = Instant::now();
    if now < *next_retry_at {
        return None;
    }
    *next_retry_at = now + Duration::from_millis(NS2PRO_WAIT_DEVICE_RETRY_MS);

    let Ok(api) = HidApi::new() else {
        return None;
    };

    let Some(next_output_path) =
        find_first_ns2pro_output_path(&api, Some(current_ns2pro_input_path))
    else {
        return None;
    };

    match open_ns2pro_output_device(&next_output_path) {
        Ok(next_device) => {
            *current_ns2pro_output_path = next_output_path;
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.ns2pro_output_path = Some(current_ns2pro_output_path.clone());
                bridge_stats.last_output_error = None;
                bridge_stats.last_error = None;
            });
            Some(next_device)
        }
        Err(error) => {
            update_ns2pro_pico_bridge_stats(stats, |bridge_stats| {
                bridge_stats.ns2pro_output_path = Some(next_output_path.clone());
                bridge_stats.last_output_error = Some(error);
            });
            None
        }
    }
}

fn ns2pro_hid_path_exists(api: &HidApi, path: &str) -> bool {
    api.device_list().any(|device| {
        device.vendor_id() == NINTENDO_VENDOR_ID
            && device.product_id() == NS2PRO_PRODUCT_ID
            && device.interface_number() >= 0
            && device.path().to_string_lossy() == path
    })
}

fn ns2pro_hid_candidates(api: &HidApi) -> Vec<Ns2ProHidCandidate> {
    api.device_list()
        .filter(|device| {
            device.vendor_id() == NINTENDO_VENDOR_ID
                && device.product_id() == NS2PRO_PRODUCT_ID
                && device.interface_number() >= 0
        })
        .map(|device| Ns2ProHidCandidate {
            path: device.path().to_string_lossy().to_string(),
            interface_number: device.interface_number(),
            usage_page: device.usage_page(),
        })
        .collect()
}

struct Ns2ProHidCandidate {
    path: String,
    interface_number: i32,
    usage_page: u16,
}

struct Ns2ProOutputDevice {
    device: hidapi::HidDevice,
}

impl Ns2ProOutputDevice {
    fn open(path: &str) -> Result<Self, String> {
        let api = HidApi::new().map_err(error_to_string)?;
        let device = open_device_by_path(&api, path)?;
        Ok(Self { device })
    }

    fn send_initialization_reports(&mut self, path: &str) -> Result<(), String> {
        let init_path = find_present_ns2pro_output_paths()
            .ok()
            .and_then(|paths| paths.into_iter().next())
            .ok_or_else(|| "No NS2Pro WinUSB init interface was found.".to_string())?;
        let mut init_device = Ns2ProWinUsbDevice::open(&init_path)?;
        for step in NS2PRO_WIRED_INIT_STEPS {
            let written = init_device.write_output_report(step.bytes)?;
            if written == 0 {
                return Err(format!(
                    "NS2Pro wired init wrote 0 bytes on {path} for command 0x{:02X}",
                    step.bytes[0]
                ));
            }
            if written < step.bytes.len() {
                return Err(format!(
                    "NS2Pro wired init wrote {written}/{} bytes on {path} for command 0x{:02X}",
                    step.bytes.len(),
                    step.bytes[0]
                ));
            }
            thread::sleep(Duration::from_millis(step.delay_after_ms));
        }
        Ok(())
    }

    fn write_report(&mut self, report: &[u8]) -> Result<usize, String> {
        if report.is_empty() {
            return Err("NS2Pro output report is empty.".to_string());
        }

        let written = self.device.write(report).map_err(error_to_string)?;
        if written != report.len() {
            return Err(format!(
                "NS2Pro output HID write incomplete: {written}/{}",
                report.len()
            ));
        }

        Ok(written)
    }
}

fn update_ns2pro_pico_bridge_stats(
    stats: &Arc<std::sync::Mutex<Ns2ProPicoBridgeStats>>,
    update: impl FnOnce(&mut Ns2ProPicoBridgeStats),
) {
    if let Ok(mut bridge_stats) = stats.lock() {
        update(&mut bridge_stats);
    }
}

fn normalize_usb_port_key(path: &str) -> String {
    let normalized = path.to_ascii_lowercase();
    if let Some(start) = normalized.find("vid_") {
        let tail = &normalized[start..];
        let end = tail.find('#').unwrap_or(tail.len());
        let mut instance = tail[..end].to_string();
        if let Some(mi_index) = instance.find("&mi_") {
            instance.truncate(mi_index);
        }
        return instance;
    }

    normalized.replace("&col", "#col")
}

fn resolve_feature_report_device_path(api: &HidApi, path: &str) -> String {
    let requested_key = normalize_usb_port_key(path);
    let devices = collect_supported_devices(api);
    let manager_devices: Vec<&HidDeviceInfoDto> = devices
        .iter()
        .filter(|device| {
            device.vendor_id == PICO_MANAGER_VENDOR_ID
                && device.product_id == PICO_MANAGER_PRODUCT_ID
        })
        .collect();

    if let Some(manager) = manager_devices.iter().find(|device| {
        device.vendor_id == PICO_MANAGER_VENDOR_ID
            && device.product_id == PICO_MANAGER_PRODUCT_ID
            && normalize_usb_port_key(&device.path) == requested_key
    }) {
        return manager.path.clone();
    }

    if manager_devices.len() == 1 {
        return manager_devices[0].path.clone();
    }

    path.to_string()
}

#[tauri::command]
pub async fn ds5_read_feature_report(
    path: String,
    report_id: u8,
    length: usize,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = HidApi::new().map_err(error_to_string)?;
        let resolved_path = resolve_feature_report_device_path(&api, &path);
        let device = open_device_by_path(&api, &resolved_path)?;
        let mut buffer = vec![0_u8; length.max(1)];
        buffer[0] = report_id;
        let count = device
            .get_feature_report(&mut buffer)
            .map_err(error_to_string)?;
        buffer.truncate(count);
        Ok(buffer)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ds5_send_feature_report(
    path: String,
    report_id: u8,
    data: Vec<u8>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = HidApi::new().map_err(error_to_string)?;
        let resolved_path = resolve_feature_report_device_path(&api, &path);
        let device = open_device_by_path(&api, &resolved_path)?;
        let mut buffer = Vec::with_capacity(data.len() + 1);
        buffer.push(report_id);
        buffer.extend_from_slice(&data);
        device
            .send_feature_report(&buffer)
            .map_err(error_to_string)?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ds5_read_input_report(
    path: String,
    timeout_ms: i32,
    length: usize,
) -> Result<Option<Vec<u8>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = HidApi::new().map_err(error_to_string)?;
        let device = open_device_by_path(&api, &path)?;
        let mut buffer = vec![0_u8; length.max(1)];
        let count = device
            .read_timeout(&mut buffer, timeout_ms.max(0))
            .map_err(error_to_string)?;

        if count == 0 {
            return Ok(None);
        }

        buffer.truncate(count);
        Ok(Some(buffer))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ds5_update_tray_batteries(
    app: AppHandle,
    state: State<'_, TrayState>,
    batteries: Vec<crate::state::TrayBatteryStatus>,
) -> Result<(), String> {
    let battery_lines = normalize_tray_battery_values(batteries.clone());
    let changed = if let Ok(mut current_values) = state.battery_values.lock() {
        if *current_values == battery_lines {
            false
        } else {
            *current_values = battery_lines.clone();
            true
        }
    } else {
        true
    };

    if !changed {
        return Ok(());
    }

    let settings = load_software_settings_async(app.clone()).await?;
    process_low_battery_notifications(&app, &state, &settings, &batteries);

    let labels = if let Ok(labels) = state.labels.lock() {
        labels.clone()
    } else {
        crate::state::TrayLabels::fallback()
    };
    crate::resize_tray_popup(&app);
    let _ = app.emit("ds5-tray-batteries-changed", battery_lines.clone());
    let menu_text = format_tray_menu_battery_text(&labels, &battery_lines);
    let tooltip_text = format!("DS5 NS2Pro Dongle Manager\n{}", battery_lines.join("\n"));

    let battery_item = state.battery_item.lock().ok().and_then(|item| item.clone());
    if let Some(item) = battery_item.as_ref() {
        item.set_text(&menu_text)
            .map_err(|error| error.to_string())?;
    }

    if let Some(tray) = app.tray_by_id("main") {
        tray.set_tooltip(Some(tooltip_text))
            .map_err(|error| error.to_string())?;

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        tray.set_title(Some(menu_text))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn normalize_tray_battery_values(batteries: Vec<crate::state::TrayBatteryStatus>) -> Vec<String> {
    let values: Vec<String> = batteries
        .into_iter()
        .filter_map(|status| {
            let battery_text = status.battery_text.trim();
            let display_value = if battery_text.is_empty() || battery_text == "--" {
                "--"
            } else {
                battery_text
            };
            let label = status.label.trim();
            if label.is_empty() {
                Some(display_value.to_string())
            } else {
                Some(format!("{label}：{display_value}"))
            }
        })
        .collect();

    values
}

fn process_low_battery_notifications(
    app: &AppHandle,
    state: &State<'_, TrayState>,
    settings: &SoftwareSettings,
    batteries: &[crate::state::TrayBatteryStatus],
) {
    if !settings.low_battery_notification_enabled {
        if let Ok(mut notified_keys) = state.low_battery_notified_keys.lock() {
            notified_keys.clear();
        }
        return;
    }

    let Ok(mut notified_keys) = state.low_battery_notified_keys.lock() else {
        return;
    };
    for status in batteries {
        let device_key = status.device_key.trim();
        if device_key.is_empty() {
            continue;
        }

        let percent = parse_battery_percent(&status.battery_text);
        if percent.map_or(true, |value| value > LOW_BATTERY_THRESHOLD_PERCENT) {
            notified_keys.remove(device_key);
            continue;
        }

        if !notified_keys.insert(device_key.to_string()) {
            continue;
        }

        let _ = play_controller_notification_sound_with_settings(
            app,
            ControllerNotificationSound::LowBattery,
            settings,
        );
    }
}

fn parse_battery_percent(battery_text: &str) -> Option<u8> {
    let percent_text = battery_text.trim().split('%').next()?.trim();
    percent_text.parse::<u8>().ok()
}

fn format_tray_menu_battery_text(
    labels: &crate::state::TrayLabels,
    battery_lines: &[String],
) -> String {
    if battery_lines.is_empty() {
        return labels.battery_prefix.to_string();
    }

    if battery_lines.len() <= 1 {
        return format!(
            "{}：{}",
            labels.battery_prefix,
            battery_lines.first().map(String::as_str).unwrap_or("--")
        );
    }

    format!("{}：{}", labels.battery_prefix, battery_lines.join("  |  "))
}

#[allow(dead_code)]
fn _legacy_single_battery_text(battery_text: String) -> String {
    let normalized_text = battery_text.trim();
    let display_value = if normalized_text.is_empty() || normalized_text == "--" {
        "--"
    } else {
        normalized_text
    };
    display_value.to_string()
}

#[tauri::command]
pub fn ds5_update_tray_labels(
    app: AppHandle,
    state: State<'_, TrayState>,
    labels: crate::state::TrayLabels,
) -> Result<(), String> {
    if let Ok(mut current_labels) = state.labels.lock() {
        *current_labels = labels.clone();
    }

    let open_window_item = state
        .open_window_item
        .lock()
        .ok()
        .and_then(|item| item.clone());
    if let Some(item) = open_window_item.as_ref() {
        item.set_text(&labels.open_window)
            .map_err(|error| error.to_string())?;
    }

    let quit_item = state.quit_item.lock().ok().and_then(|item| item.clone());
    if let Some(item) = quit_item.as_ref() {
        item.set_text(&labels.quit)
            .map_err(|error| error.to_string())?;
    }

    let battery_values = if let Ok(current_values) = state.battery_values.lock() {
        current_values.clone()
    } else {
        vec!["--".to_string()]
    };
    let menu_text = format_tray_menu_battery_text(&labels, &battery_values);

    let battery_item = state.battery_item.lock().ok().and_then(|item| item.clone());
    if let Some(item) = battery_item.as_ref() {
        item.set_text(&menu_text)
            .map_err(|error| error.to_string())?;
    }

    if let Some(tray) = app.tray_by_id("main") {
        tray.set_tooltip(Some(format!(
            "DS5 NS2Pro Dongle Manager\n{}",
            battery_values.join("\n")
        )))
        .map_err(|error| error.to_string())?;

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        tray.set_title(Some(menu_text))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn ds5_set_close_to_tray(
    app: AppHandle,
    state: State<'_, TrayState>,
    close_to_tray: bool,
) -> Result<(), String> {
    update_close_to_tray_state(&state, close_to_tray, true)?;
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.close_to_tray = close_to_tray;
    settings.close_to_tray_asked = true;
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings);
    Ok(())
}

#[tauri::command]
pub async fn ds5_get_close_to_tray(
    app: AppHandle,
    state: State<'_, TrayState>,
) -> Result<bool, String> {
    let settings = sync_software_settings_state_async(app, &state).await?;
    let close_to_tray = settings.close_to_tray;
    Ok(close_to_tray)
}

#[tauri::command]
pub async fn ds5_get_software_settings(
    app: AppHandle,
    state: State<'_, TrayState>,
) -> Result<SoftwareSettingsDto, String> {
    let settings = sync_software_settings_state_async(app, &state).await?;
    Ok(settings.into())
}

#[tauri::command]
pub async fn ds5_set_low_battery_notification_enabled(
    app: AppHandle,
    state: State<'_, TrayState>,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.low_battery_notification_enabled = enabled;
    if !enabled {
        if let Ok(mut notified_keys) = state.low_battery_notified_keys.lock() {
            notified_keys.clear();
        }
    }
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings);
    Ok(())
}

#[tauri::command]
pub async fn ds5_get_low_battery_notification_enabled(app: AppHandle) -> Result<bool, String> {
    Ok(load_software_settings_async(app)
        .await?
        .low_battery_notification_enabled)
}

#[tauri::command]
pub async fn ds5_set_controller_connection_popup_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.controller_connection_popup_enabled = enabled;
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings);
    Ok(())
}

#[tauri::command]
pub async fn ds5_get_controller_connection_popup_enabled(app: AppHandle) -> Result<bool, String> {
    Ok(load_software_settings_async(app)
        .await?
        .controller_connection_popup_enabled)
}

#[tauri::command]
pub async fn ds5_set_controller_low_battery_popup_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.controller_low_battery_popup_enabled = enabled;
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings);
    Ok(())
}

#[tauri::command]
pub async fn ds5_get_controller_low_battery_popup_enabled(app: AppHandle) -> Result<bool, String> {
    Ok(load_software_settings_async(app)
        .await?
        .controller_low_battery_popup_enabled)
}

#[tauri::command]
pub async fn ds5_set_controller_notification_popup_duration_ms(
    app: AppHandle,
    duration_ms: u64,
) -> Result<u64, String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.controller_notification_popup_duration_ms = normalize_popup_duration_ms(duration_ms);
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings.clone());
    Ok(settings.controller_notification_popup_duration_ms)
}

#[tauri::command]
pub async fn ds5_get_controller_notification_popup_duration_ms(
    app: AppHandle,
) -> Result<u64, String> {
    Ok(normalize_popup_duration_ms(
        load_software_settings_async(app)
            .await?
            .controller_notification_popup_duration_ms,
    ))
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControllerNotificationSound {
    Connected,
    Disconnected,
    LowBattery,
}

#[tauri::command]
pub async fn ds5_set_controller_notification_sound_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.controller_notification_sound_enabled = enabled;
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings);
    Ok(())
}

#[tauri::command]
pub async fn ds5_get_controller_notification_sound_enabled(app: AppHandle) -> Result<bool, String> {
    Ok(load_software_settings_async(app)
        .await?
        .controller_notification_sound_enabled)
}

#[tauri::command]
pub async fn ds5_get_controller_notification_sound_volumes(
    app: AppHandle,
) -> Result<ControllerNotificationSoundVolumes, String> {
    Ok(load_software_settings_async(app)
        .await?
        .controller_notification_sound_volumes
        .normalized())
}

#[tauri::command]
pub async fn ds5_set_controller_notification_sound_volume(
    app: AppHandle,
    sound: ControllerNotificationSound,
    volume: f32,
) -> Result<ControllerNotificationSoundVolumes, String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    let normalized_volume = normalize_volume(volume);
    match sound {
        ControllerNotificationSound::Connected => {
            settings.controller_notification_sound_volumes.connected = normalized_volume
        }
        ControllerNotificationSound::Disconnected => {
            settings.controller_notification_sound_volumes.disconnected = normalized_volume
        }
        ControllerNotificationSound::LowBattery => {
            settings.controller_notification_sound_volumes.low_battery = normalized_volume
        }
    }
    settings.controller_notification_sound_volumes =
        settings.controller_notification_sound_volumes.normalized();
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings.clone());
    Ok(settings.controller_notification_sound_volumes)
}

#[tauri::command]
pub async fn ds5_reset_controller_notification_sound_volumes(
    app: AppHandle,
) -> Result<ControllerNotificationSoundVolumes, String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.controller_notification_sound_volumes = ControllerNotificationSoundVolumes::default();
    save_software_settings_async(app.clone(), settings.clone()).await?;
    emit_software_settings_changed(&app, settings.clone());
    Ok(settings.controller_notification_sound_volumes)
}

#[tauri::command]
pub async fn ds5_play_controller_notification_sound(
    app: AppHandle,
    sound: ControllerNotificationSound,
) -> Result<(), String> {
    let settings = load_software_settings_async(app.clone()).await?;
    play_controller_notification_sound_with_settings(&app, sound, &settings)
}

fn play_controller_notification_sound_with_settings(
    app: &AppHandle,
    sound: ControllerNotificationSound,
    settings: &SoftwareSettings,
) -> Result<(), String> {
    if !settings.controller_notification_sound_enabled {
        return Ok(());
    }

    let volume = settings
        .clone()
        .controller_notification_sound_volumes
        .normalized()
        .volume_for(&sound);
    if volume <= 0.0 {
        return Ok(());
    }

    let resource = match sound {
        ControllerNotificationSound::Connected => CONTROLLER_CONNECTED_SOUND,
        ControllerNotificationSound::Disconnected => CONTROLLER_DISCONNECTED_SOUND,
        ControllerNotificationSound::LowBattery => CONTROLLER_LOW_BATTERY_SOUND,
    };
    let sound_path = app
        .path()
        .resolve(resource, BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;

    thread::spawn(move || {
        if let Ok(file) = fs::File::open(sound_path) {
            if let Ok((_stream, stream_handle)) = OutputStream::try_default() {
                if let Ok(sink) = Sink::try_new(&stream_handle) {
                    sink.set_volume(volume);
                    if let Ok(source) = Decoder::new(BufReader::new(file)) {
                        sink.append(source);
                        sink.sleep_until_end();
                    }
                }
            }
        }
    });

    Ok(())
}

fn normalize_volume(volume: f32) -> f32 {
    if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

impl From<Ns2ProPicoBridgeStats> for Ns2ProPicoBridgeStatusDto {
    fn from(stats: Ns2ProPicoBridgeStats) -> Self {
        Self {
            running: stats.running,
            pico_path: stats.pico_path,
            ns2pro_path: stats.ns2pro_path,
            ns2pro_output_path: stats.ns2pro_output_path,
            input_transport: stats.input_transport,
            input_transport_port: stats.input_transport_port,
            input_transport_error: stats.input_transport_error,
            waiting_reason: stats.waiting_reason,
            input_reports_received: stats.input_reports_received,
            input_reports_forwarded: stats.input_reports_forwarded,
            output_reports_received: stats.output_reports_received,
            output_reports_forwarded: stats.output_reports_forwarded,
            oversized_reports: stats.oversized_reports,
            write_errors: stats.write_errors,
            read_errors: stats.read_errors,
            last_serial_output_report_len: stats.last_serial_output_report_len,
            last_serial_output_report_head_hex: stats.last_serial_output_report_head_hex,
            last_output_report_len: stats.last_output_report_len,
            last_output_report_head_hex: stats.last_output_report_head_hex,
            last_output_write_len: stats.last_output_write_len,
            last_output_error: stats.last_output_error,
            last_error: stats.last_error,
        }
    }
}

fn normalize_popup_duration_ms(duration_ms: u64) -> u64 {
    duration_ms.clamp(2_000, 15_000)
}

fn software_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(SOFTWARE_SETTINGS_FILE_NAME))
        .map_err(|error| error.to_string())
}

fn load_software_settings(app: &AppHandle) -> Result<SoftwareSettings, String> {
    load_software_settings_from_path(software_settings_path(app)?)
}

pub fn load_start_minimized_setting(app: &AppHandle) -> Result<bool, String> {
    Ok(load_software_settings(app)?.start_minimized)
}

fn load_software_settings_from_path(path: PathBuf) -> Result<SoftwareSettings, String> {
    if !path.exists() {
        return Ok(SoftwareSettings::default());
    }

    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

async fn load_software_settings_async(app: AppHandle) -> Result<SoftwareSettings, String> {
    let path = software_settings_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_software_settings_from_path(path))
        .await
        .map_err(|error| error.to_string())?
}

fn save_software_settings_to_path(path: PathBuf, settings: SoftwareSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let contents = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

async fn save_software_settings_async(
    app: AppHandle,
    settings: SoftwareSettings,
) -> Result<(), String> {
    let path = software_settings_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || save_software_settings_to_path(path, settings))
        .await
        .map_err(|error| error.to_string())?
}

pub fn sync_close_to_tray_state(
    app: &AppHandle,
    state: &State<'_, TrayState>,
) -> Result<(), String> {
    sync_software_settings_state(app, state).map(|_| ())
}

fn sync_software_settings_state(
    app: &AppHandle,
    state: &State<'_, TrayState>,
) -> Result<SoftwareSettings, String> {
    let mut settings = load_software_settings(app)?;
    settings.autostart_enabled = app
        .autolaunch()
        .is_enabled()
        .unwrap_or(settings.autostart_enabled);
    update_close_to_tray_state(state, settings.close_to_tray, settings.close_to_tray_asked)?;
    Ok(settings)
}

async fn sync_software_settings_state_async(
    app: AppHandle,
    state: &State<'_, TrayState>,
) -> Result<SoftwareSettings, String> {
    let mut settings = load_software_settings_async(app.clone()).await?;
    settings.autostart_enabled = app
        .autolaunch()
        .is_enabled()
        .unwrap_or(settings.autostart_enabled);
    update_close_to_tray_state(state, settings.close_to_tray, settings.close_to_tray_asked)?;
    Ok(settings)
}

fn update_close_to_tray_state(
    state: &State<'_, TrayState>,
    close_to_tray: bool,
    close_to_tray_asked: bool,
) -> Result<(), String> {
    *state
        .close_to_tray
        .lock()
        .map_err(|error| error.to_string())? = close_to_tray;
    *state
        .close_to_tray_asked
        .lock()
        .map_err(|error| error.to_string())? = close_to_tray_asked;
    Ok(())
}

fn emit_software_settings_changed(app: &AppHandle, settings: SoftwareSettings) {
    let _ = app.emit(
        "ds5-software-settings-changed",
        SoftwareSettingsDto::from(settings),
    );
}

impl From<SoftwareSettings> for SoftwareSettingsDto {
    fn from(settings: SoftwareSettings) -> Self {
        Self {
            autostart_enabled: settings.autostart_enabled,
            start_minimized: settings.start_minimized,
            ns2pro_auto_detect_enabled: settings.ns2pro_auto_detect_enabled,
            close_to_tray: settings.close_to_tray,
            close_to_tray_asked: settings.close_to_tray_asked,
            low_battery_notification_enabled: settings.low_battery_notification_enabled,
            controller_connection_popup_enabled: settings.controller_connection_popup_enabled,
            controller_low_battery_popup_enabled: settings.controller_low_battery_popup_enabled,
            controller_notification_popup_duration_ms: normalize_popup_duration_ms(
                settings.controller_notification_popup_duration_ms,
            ),
            controller_notification_sound_enabled: settings.controller_notification_sound_enabled,
            controller_notification_sound_volumes: settings
                .controller_notification_sound_volumes
                .normalized(),
        }
    }
}
