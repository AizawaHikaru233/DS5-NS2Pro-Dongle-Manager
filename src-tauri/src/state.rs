use serde::Deserialize;
use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{menu::MenuItem, Wry};

pub struct DeviceMonitorState {
    pub running: Arc<AtomicBool>,
}

pub struct Ns2ProPicoBridgeState {
    pub running: Arc<AtomicBool>,
    pub stats: Arc<Mutex<Ns2ProPicoBridgeStats>>,
    pub manual_pairing_until: Arc<Mutex<Option<Instant>>>,
}

pub struct Ns2ProAutoDetectState {
    pub running: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct Ns2ProPicoBridgeStats {
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

pub struct TrayState {
    pub battery_values: Mutex<Vec<String>>,
    pub labels: Mutex<TrayLabels>,
    pub close_to_tray: Mutex<bool>,
    pub close_to_tray_asked: Mutex<bool>,
    pub low_battery_notified_keys: Mutex<HashSet<String>>,
    pub open_window_item: Mutex<Option<MenuItem<Wry>>>,
    pub battery_item: Mutex<Option<MenuItem<Wry>>>,
    pub quit_item: Mutex<Option<MenuItem<Wry>>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayBatteryStatus {
    pub device_key: String,
    pub label: String,
    pub battery_text: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub open_window: String,
    pub quit: String,
    pub battery_prefix: String,
}

impl TrayLabels {
    pub fn fallback() -> Self {
        Self {
            open_window: "Open Window".to_string(),
            quit: "Quit".to_string(),
            battery_prefix: "Controller Battery".to_string(),
        }
    }
}
