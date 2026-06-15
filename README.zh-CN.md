# DS5 NS2Pro Dongle Manager

[English](README.md)

[DS5_NS2Pro_Dongle](https://github.com/AizawaHikaru233/DS5_NS2Pro_Dongle) 的桌面管理器。它是一个 Tauri + React 应用，用来配置 Pico 固件、查看连接状态、管理 NS2Pro 配对，并在需要 PC 侧桥接时转发有线 NS2Pro 输入。

## 安装

1. 从 [Releases](https://github.com/AizawaHikaru233/DS5-NS2Pro-Dongle-Manager/releases) 下载最新的 `DS5 NS2Pro Dongle Manager_*.msi`。
2. 安装 MSI。
3. 从固件仓库刷入匹配版本的 UF2 固件。
4. 连接 Pico Dongle，打开管理器。

## 功能

- 显示 Pico 固件版本、信号和手柄连接状态。
- 通过 Pico 管理 HID 协议下发固件配置。
- 启动 NS2Pro 有线配对和 NS2Pro 蓝牙配对流程。
- 在固件支持的范围内，让 NS2Pro 设置和 DS5 设置相互独立。
- 在需要时提供最小化的 PC 侧有线 NS2Pro 输入桥接。

## 跟原版 DS5Dongle 的区别

这个仓库不是原版 DS5Dongle 的通用前端，而是 DS5 + NS2Pro 分支的管理器：

- 原版 DS5Dongle 主要让 DualSense 通过 Pico 以有线 DualSense 的形式连接主机。
- 本项目额外支持把 NS2Pro 输入转译为 DualSense 兼容 USB 设备。
- NS2Pro 的输入、陀螺仪、震动风格、配对和配置文件尽量与原始 DS5 路径独立。
- 桌面端保持轻量，DS5 报文生成、NS2Pro 转译、陀螺仪校准和触觉反馈转换主要由固件完成。

## 构建依赖

- Windows 10/11
- Node.js 24
- pnpm 11
- Rust stable MSVC 工具链
- Visual Studio Build Tools 或带 C++ 工具的 Visual Studio
- WebView2 Runtime

## 构建

```powershell
pnpm install
pnpm build
pnpm tauri build --bundles msi
```

MSI 输出目录：

```text
src-tauri/target/release/bundle/msi/
```

## 一键发布

GitHub Actions 里已经提供 `Release manager`。

1. 打开 Actions。
2. 选择 `Release manager`。
3. 点击运行 workflow。
4. 输入版本号，例如 `1.0.0`。

workflow 会创建或更新 `v1.0.0` Release，构建 Windows MSI，并上传到 GitHub Release。

## 参考来源

- 固件仓库：[AizawaHikaru233/DS5_NS2Pro_Dongle](https://github.com/AizawaHikaru233/DS5_NS2Pro_Dongle)
- 管理器来源：[GooGuJiang/ds5dongle-manager](https://github.com/GooGuJiang/ds5dongle-manager)
- 原始固件来源：[awalol/DS5Dongle](https://github.com/awalol/DS5Dongle)
- NS2Pro 桥接参考：[LeonChrome/y700-switch2-pro-bridge](https://github.com/LeonChrome/y700-switch2-pro-bridge)

## 许可证

MIT。来自上游项目的代码保留来源说明。
