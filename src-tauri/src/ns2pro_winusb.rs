#[cfg(target_os = "windows")]
mod imp {
    use std::collections::BTreeSet;
    use std::iter;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::{GUID, PCWSTR};
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_GET_DEVICE_INTERFACE_LIST_PRESENT, CM_Get_Device_Interface_List_SizeW,
        CM_Get_Device_Interface_ListW, CR_SUCCESS,
    };
    use windows::Win32::Devices::Usb::{
        WinUsb_Free, WinUsb_Initialize, WinUsb_WritePipe, WINUSB_INTERFACE_HANDLE,
    };
    use windows::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    const NS2PRO_WINUSB_OUT_PIPE_ID: u8 = 0x02;
    const NS2PRO_WINUSB_INTERFACE_GUIDS: [GUID; 2] = [
        GUID::from_u128(0x6f13725e_ef0e_4fd3_ae5f_b2de989ec825),
        GUID::from_u128(0xdee824ef_729b_4a0e_9c14_b7117d33a817),
    ];
    const NS2PRO_WINUSB_PATH_TAG: &str = "USB#VID_057E&PID_2069&MI_01#";

    pub struct Ns2ProWinUsbDevice {
        file: HANDLE,
        handle: WINUSB_INTERFACE_HANDLE,
    }

    impl Ns2ProWinUsbDevice {
        pub fn open(path: &str) -> Result<Self, String> {
            let wide_path = std::ffi::OsStr::new(path)
                .encode_wide()
                .chain(iter::once(0))
                .collect::<Vec<u16>>();

            let file = unsafe {
                CreateFileW(
                    PCWSTR(wide_path.as_ptr()),
                    GENERIC_READ.0 | GENERIC_WRITE.0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    None,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
                    None,
                )
            }
            .map_err(|error| format!("CreateFileW failed for {path}: {error}"))?;

            if file == INVALID_HANDLE_VALUE {
                return Err(format!("CreateFileW returned INVALID_HANDLE_VALUE for {path}."));
            }

            let mut handle = WINUSB_INTERFACE_HANDLE(std::ptr::null_mut());
            if let Err(error) = unsafe { WinUsb_Initialize(file, &mut handle) } {
                unsafe {
                    let _ = CloseHandle(file);
                }
                return Err(format!("WinUsb_Initialize failed for {path}: {error}"));
            }

            Ok(Self { file, handle })
        }

        pub fn write_output_report(&mut self, report: &[u8]) -> Result<usize, String> {
            let mut written = 0u32;
            unsafe {
                WinUsb_WritePipe(
                    self.handle,
                    NS2PRO_WINUSB_OUT_PIPE_ID,
                    report,
                    Some(&mut written),
                    None,
                )
            }
            .map_err(|error| format!("WinUsb_WritePipe failed: {error}"))?;

            if written as usize != report.len() {
                return Err(format!(
                    "WinUsb_WritePipe incomplete: {written}/{} bytes",
                    report.len()
                ));
            }

            Ok(written as usize)
        }
    }

    impl Drop for Ns2ProWinUsbDevice {
        fn drop(&mut self) {
            unsafe {
                let _ = WinUsb_Free(self.handle).ok();
                let _ = CloseHandle(self.file);
            }
        }
    }

    pub fn find_present_ns2pro_output_paths() -> Result<Vec<String>, String> {
        let mut paths = Vec::new();
        let mut seen = BTreeSet::new();

        for guid in NS2PRO_WINUSB_INTERFACE_GUIDS {
            for path in collect_present_interface_paths(guid)? {
                if !path.contains(NS2PRO_WINUSB_PATH_TAG) {
                    continue;
                }
                if seen.insert(path.clone()) {
                    paths.push(path);
                }
            }
        }

        Ok(paths)
    }

    fn collect_present_interface_paths(interface_guid: GUID) -> Result<Vec<String>, String> {
        let mut required_len = 0u32;
        let size_result = unsafe {
            CM_Get_Device_Interface_List_SizeW(
                &mut required_len,
                &interface_guid,
                PCWSTR::null(),
                CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
            )
        };
        if size_result != CR_SUCCESS {
            return Err(format!(
                "CM_Get_Device_Interface_List_SizeW failed for {interface_guid:?}: {:?}",
                size_result
            ));
        }
        if required_len == 0 {
            return Ok(Vec::new());
        }

        let mut buffer = vec![0u16; required_len as usize];
        let list_result = unsafe {
            CM_Get_Device_Interface_ListW(
                &interface_guid,
                PCWSTR::null(),
                &mut buffer,
                CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
            )
        };
        if list_result != CR_SUCCESS {
            return Err(format!(
                "CM_Get_Device_Interface_ListW failed for {interface_guid:?}: {:?}",
                list_result
            ));
        }

        Ok(parse_multi_sz(&buffer))
    }

    fn parse_multi_sz(buffer: &[u16]) -> Vec<String> {
        let mut items = Vec::new();
        let mut start = 0usize;

        while start < buffer.len() {
            let Some(relative_end) = buffer[start..].iter().position(|value| *value == 0) else {
                break;
            };
            if relative_end == 0 {
                break;
            }
            let end = start + relative_end;
            items.push(String::from_utf16_lossy(&buffer[start..end]));
            start = end + 1;
        }

        items
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub struct Ns2ProWinUsbDevice;

    impl Ns2ProWinUsbDevice {
        pub fn open(_path: &str) -> Result<Self, String> {
            Err("NS2Pro WinUSB output is only supported on Windows.".to_string())
        }

        pub fn write_output_report(&mut self, _report: &[u8]) -> Result<usize, String> {
            Err("NS2Pro WinUSB output is only supported on Windows.".to_string())
        }
    }

    pub fn find_present_ns2pro_output_paths() -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

pub use imp::{find_present_ns2pro_output_paths, Ns2ProWinUsbDevice};
