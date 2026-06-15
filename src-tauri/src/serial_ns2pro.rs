#[cfg(windows)]
mod imp {
    use std::io::{self, Read};
    use std::process::Command;

    use windows::core::PCSTR;
    use windows::Win32::Devices::Communication::{
        EscapeCommFunction, GetCommState, SetCommState, SetCommTimeouts, COMMTIMEOUTS, DCB,
        NOPARITY, ONESTOPBIT, SETDTR, SETRTS,
    };
    use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileA, QueryDosDeviceA, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    const SERIAL_MAGIC0: u8 = 0xE5;
    const SERIAL_MAGIC1: u8 = 0x50;
    const SERIAL_FRAME_NS2PRO_RAW: u8 = 0x03;
    const SERIAL_FRAME_NS2PRO_OUTPUT: u8 = 0x04;
    const SERIAL_BAUD: u32 = 921_600;
    const NS2PRO_OUTPUT_REPORT_LEN: usize = 64;
    const SERIAL_MAX_PAYLOAD_LEN: usize = u8::MAX as usize;
    const SERIAL_READ_CHUNK_LEN: usize = 128;

    pub struct Ns2ProSerialBridge {
        handle: HANDLE,
        sequence: u8,
        port_name: String,
        read_buffer: Vec<u8>,
    }

    impl Ns2ProSerialBridge {
        pub fn open_auto() -> Result<Self, String> {
            let port_name = preferred_serial_port(None)
                .ok_or_else(|| "No Pico CDC serial port was found.".to_string())?;
            Self::open(&port_name)
        }

        pub fn open_for_pico_path(pico_path: Option<&str>) -> Result<Self, String> {
            let port_name = preferred_serial_port(pico_path)
                .ok_or_else(|| "No Pico CDC serial port was found.".to_string())?;
            Self::open(&port_name)
        }

        pub fn open(port_name: &str) -> Result<Self, String> {
            let device_path = serial_device_path(port_name);
            let mut path_bytes = device_path.into_bytes();
            path_bytes.push(0);

            let handle = unsafe {
                CreateFileA(
                    PCSTR(path_bytes.as_ptr()),
                    FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    None,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    None,
                )
            }
            .map_err(|error| format!("Open serial {port_name} failed: {error}"))?;

            if handle == INVALID_HANDLE_VALUE {
                return Err(format!("Open serial {port_name} failed"));
            }

            if let Err(error) = configure_serial(handle) {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                return Err(error);
            }

            Ok(Self {
                handle,
                sequence: 0,
                port_name: port_name.to_string(),
                read_buffer: Vec::new(),
            })
        }

        pub fn write_ns2pro_report(&mut self, payload: &[u8]) -> Result<(), String> {
            if payload.is_empty() || payload.len() > u8::MAX as usize {
                return Err(format!("Invalid NS2Pro serial payload length {}", payload.len()));
            }

            let mut frame = Vec::with_capacity(6 + payload.len());
            frame.push(SERIAL_MAGIC0);
            frame.push(SERIAL_MAGIC1);
            frame.push(SERIAL_FRAME_NS2PRO_RAW);
            frame.push(payload.len() as u8);
            frame.push(self.sequence);
            frame.extend_from_slice(payload);
            let checksum = frame.iter().fold(0_u8, |acc, byte| acc ^ byte);
            frame.push(checksum);
            self.sequence = self.sequence.wrapping_add(1);

            let mut written = 0_u32;
            unsafe {
                WriteFile(
                    self.handle,
                    Some(&frame),
                    Some(&mut written),
                    None,
                )
            }
            .map_err(|error| format!("Write serial {} failed: {error}", self.port_name))?;

            if written as usize != frame.len() {
                return Err(format!(
                    "Write serial {} incomplete: {written}/{}",
                    self.port_name,
                    frame.len()
                ));
            }

            Ok(())
        }

        pub fn read_ns2pro_output_reports(&mut self) -> Result<Vec<[u8; NS2PRO_OUTPUT_REPORT_LEN]>, String> {
            let mut chunk = [0_u8; SERIAL_READ_CHUNK_LEN];
            loop {
                let mut bytes_read = 0_u32;
                unsafe {
                    ReadFile(
                        self.handle,
                        Some(&mut chunk),
                        Some(&mut bytes_read),
                        None,
                    )
                }
                .map_err(|error| format!("Read serial {} failed: {error}", self.port_name))?;

                if bytes_read == 0 {
                    break;
                }
                self.read_buffer
                    .extend_from_slice(&chunk[..bytes_read as usize]);

                if bytes_read as usize != chunk.len() {
                    break;
                }
            }

            Ok(self.parse_output_reports())
        }

        pub fn port_name(&self) -> &str {
            &self.port_name
        }

        fn parse_output_reports(&mut self) -> Vec<[u8; NS2PRO_OUTPUT_REPORT_LEN]> {
            let mut reports = Vec::new();
            let mut cursor = 0_usize;

            while self.read_buffer.len().saturating_sub(cursor) >= 6 {
                if self.read_buffer[cursor] != SERIAL_MAGIC0 {
                    cursor += 1;
                    continue;
                }

                if self.read_buffer[cursor + 1] != SERIAL_MAGIC1 {
                    cursor += 1;
                    continue;
                }

                let payload_len = self.read_buffer[cursor + 3] as usize;
                if payload_len > SERIAL_MAX_PAYLOAD_LEN {
                    cursor += 1;
                    continue;
                }

                let frame_len = 5 + payload_len + 1;
                if self.read_buffer.len().saturating_sub(cursor) < frame_len {
                    break;
                }

                let frame = &self.read_buffer[cursor..cursor + frame_len];
                let checksum = frame[..frame_len - 1]
                    .iter()
                    .fold(0_u8, |acc, byte| acc ^ byte);
                if checksum != frame[frame_len - 1] {
                    cursor += 1;
                    continue;
                }

                if frame[2] == SERIAL_FRAME_NS2PRO_OUTPUT && payload_len == NS2PRO_OUTPUT_REPORT_LEN {
                    let mut report = [0_u8; NS2PRO_OUTPUT_REPORT_LEN];
                    report.copy_from_slice(&frame[5..5 + NS2PRO_OUTPUT_REPORT_LEN]);
                    reports.push(report);
                }

                cursor += frame_len;
            }

            if cursor > 0 {
                self.read_buffer.drain(..cursor);
            }
            if self.read_buffer.len() > 1024 {
                let keep_from = self.read_buffer.len() - 256;
                self.read_buffer.drain(..keep_from);
            }

            reports
        }
    }

    impl Drop for Ns2ProSerialBridge {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }

    fn configure_serial(handle: HANDLE) -> Result<(), String> {
        let mut dcb = DCB::default();
        dcb.DCBlength = std::mem::size_of::<DCB>() as u32;
        unsafe {
            GetCommState(handle, &mut dcb)
        }
        .map_err(|error| format!("Get serial state failed: {error}"))?;

        dcb.DCBlength = std::mem::size_of::<DCB>() as u32;
        dcb.BaudRate = SERIAL_BAUD;
        dcb.ByteSize = 8;
        dcb.Parity = NOPARITY;
        dcb.StopBits = ONESTOPBIT;

        unsafe {
            SetCommState(handle, &dcb)
        }
        .map_err(|error| format!("Set serial state failed: {error}"))?;

        let timeouts = COMMTIMEOUTS {
            ReadIntervalTimeout: u32::MAX,
            ReadTotalTimeoutMultiplier: 0,
            ReadTotalTimeoutConstant: 0,
            WriteTotalTimeoutMultiplier: 0,
            WriteTotalTimeoutConstant: 250,
        };
        unsafe {
            SetCommTimeouts(handle, &timeouts)
        }
        .map_err(|error| format!("Set serial timeouts failed: {error}"))?;

        unsafe {
            EscapeCommFunction(handle, SETDTR)
        }
        .map_err(|error| format!("Set serial DTR failed: {error}"))?;

        unsafe {
            EscapeCommFunction(handle, SETRTS)
        }
        .map_err(|error| format!("Set serial RTS failed: {error}"))
    }

    fn serial_device_path(port_name: &str) -> String {
        let normalized = port_name.trim();
        if normalized.starts_with(r"\\.\") {
            normalized.to_string()
        } else {
            format!(r"\\.\{normalized}")
        }
    }

    fn preferred_serial_port(pico_path: Option<&str>) -> Option<String> {
        if let Ok(port) = std::env::var("DS5_NS2PRO_SERIAL_PORT") {
            let trimmed = port.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }

        let pnp_entries = serial_ports_from_pnp()
            .into_iter()
            .filter(|entry| serial_port_exists(&entry.port_name))
            .collect::<Vec<_>>();
        let registry_entries = serial_ports_from_registry()
            .into_iter()
            .filter(|entry| serial_port_exists(&entry.port_name))
            .collect::<Vec<_>>();

        if let Some(path) = pico_path {
            if let Some(entry) = pnp_entries
                .iter()
                .chain(registry_entries.iter())
                .find(|entry| serial_entry_matches_pico_path(entry, path))
            {
                return Some(entry.port_name.clone());
            }
        }

        pnp_entries
            .iter()
            .chain(registry_entries.iter())
            .find(|entry| serial_entry_has_key(entry, "VID_054C", "PID_0CE6", Some("MI_04")))
            .cloned()
            .or_else(|| {
                pnp_entries
                    .iter()
                    .chain(registry_entries.iter())
                    .find(|entry| serial_entry_has_key(entry, "VID_054C", "PID_0DF2", Some("MI_04")))
                    .cloned()
            })
            .or_else(|| {
                pnp_entries
                    .iter()
                    .chain(registry_entries.iter())
                    .find(|entry| serial_entry_has_key(entry, "VID_2E8A", "PID_00D5", None))
                    .cloned()
            })
            .or_else(|| {
                registry_entries
                    .into_iter()
                    .next()
            })
            .map(|entry| entry.port_name)
    }

    pub fn has_serial_companion_for_pico_path(path: &str) -> bool {
        preferred_serial_port(Some(path)).is_some()
    }

    fn serial_port_exists(port_name: &str) -> bool {
        let mut name_bytes = port_name.trim().as_bytes().to_vec();
        if name_bytes.is_empty() {
            return false;
        }
        name_bytes.push(0);

        let mut target = [0_u8; 512];
        unsafe { QueryDosDeviceA(PCSTR(name_bytes.as_ptr()), Some(&mut target)) > 0 }
    }

    #[derive(Clone)]
    struct SerialPortEntry {
        device_key: String,
        port_name: String,
    }

    fn serial_ports_from_pnp() -> Vec<SerialPortEntry> {
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_SerialPort | ForEach-Object { Write-Output ($_.DeviceID + \"`t\" + $_.PNPDeviceID) }",
            ])
            .output();
        let Ok(output) = output else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }

        let mut bytes = output.stdout;
        bytes.extend_from_slice(&output.stderr);
        let text = decode_command_output(&bytes);
        text.lines()
            .filter_map(parse_pnp_serial_line)
            .collect()
    }

    fn parse_pnp_serial_line(line: &str) -> Option<SerialPortEntry> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }

        let mut parts = trimmed.splitn(2, '\t');
        let port_name = parts.next()?.trim().to_string();
        let device_key = parts.next()?.trim().to_string();
        if !port_name.to_ascii_uppercase().starts_with("COM") || device_key.is_empty() {
            return None;
        }

        Some(SerialPortEntry {
            device_key,
            port_name,
        })
    }

    fn serial_ports_from_registry() -> Vec<SerialPortEntry> {
        let output = Command::new("reg")
            .args(["query", r"HKLM\HARDWARE\DEVICEMAP\SERIALCOMM"])
            .output();
        let Ok(output) = output else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }

        let mut bytes = output.stdout;
        bytes.extend_from_slice(&output.stderr);
        let text = decode_command_output(&bytes);
        text.lines()
            .filter_map(parse_serial_registry_line)
            .collect()
    }

    fn parse_serial_registry_line(line: &str) -> Option<SerialPortEntry> {
        let trimmed = line.trim();
        if !trimmed.contains("REG_SZ") {
            return None;
        }

        let columns = trimmed
            .split_whitespace()
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        let reg_index = columns.iter().position(|part| *part == "REG_SZ")?;
        let device_key = columns.get(..reg_index)?.join(" ");
        let port_name = columns.get(reg_index + 1)?.to_string();
        if !port_name.to_ascii_uppercase().starts_with("COM") {
            return None;
        }

        Some(SerialPortEntry {
            device_key,
            port_name,
        })
    }

    fn serial_entry_has_key(
        entry: &SerialPortEntry,
        vid: &str,
        pid: &str,
        mi: Option<&str>,
    ) -> bool {
        let key = entry.device_key.to_ascii_uppercase();
        if !key.contains(vid) || !key.contains(pid) {
            return false;
        }
        match mi {
            Some(value) => key.contains(value),
            None => true,
        }
    }

    fn serial_entry_matches_pico_path(entry: &SerialPortEntry, pico_path: &str) -> bool {
        let normalized_path = pico_path.to_ascii_uppercase();
        let key = entry.device_key.to_ascii_uppercase();
        let Some(stem) = usb_instance_stem_from_hid_path(&normalized_path) else {
            return false;
        };
        key.contains(&stem)
            && ((normalized_path.contains("VID_054C") && key.contains("VID_054C"))
                || (normalized_path.contains("VID_2E8A") && key.contains("VID_2E8A")))
    }

    fn usb_instance_stem_from_hid_path(path: &str) -> Option<String> {
        let mut parts = path.split('#');
        let _prefix = parts.next()?;
        let _hardware = parts.next()?;
        let instance = parts.next()?;
        let stem = instance
            .split('&')
            .take(3)
            .collect::<Vec<_>>()
            .join("&");
        if stem.is_empty() {
            None
        } else {
            Some(stem.to_ascii_uppercase())
        }
    }

    fn decode_command_output(bytes: &[u8]) -> String {
        String::from_utf8(bytes.to_vec())
            .or_else(|_| read_to_string_lossy(bytes))
            .unwrap_or_default()
    }

    fn read_to_string_lossy(bytes: &[u8]) -> io::Result<String> {
        let mut cursor = io::Cursor::new(bytes);
        let mut raw = Vec::new();
        cursor.read_to_end(&mut raw)?;
        Ok(raw.iter().map(|byte| *byte as char).collect())
    }
}

#[cfg(windows)]
pub use imp::{has_serial_companion_for_pico_path, Ns2ProSerialBridge};

#[cfg(not(windows))]
pub struct Ns2ProSerialBridge;

#[cfg(not(windows))]
impl Ns2ProSerialBridge {
    pub fn open_auto() -> Result<Self, String> {
        Err("Serial NS2Pro bridge is only available on Windows.".to_string())
    }

    pub fn open_for_pico_path(_pico_path: Option<&str>) -> Result<Self, String> {
        Err("Serial NS2Pro bridge is only available on Windows.".to_string())
    }

    pub fn write_ns2pro_report(&mut self, _payload: &[u8]) -> Result<(), String> {
        Err("Serial NS2Pro bridge is only available on Windows.".to_string())
    }

    pub fn read_ns2pro_output_reports(&mut self) -> Result<Vec<[u8; 64]>, String> {
        Err("Serial NS2Pro bridge is only available on Windows.".to_string())
    }

    pub fn port_name(&self) -> &str {
        ""
    }
}

#[cfg(not(windows))]
pub fn has_serial_companion_for_pico_path(_path: &str) -> bool {
    false
}
