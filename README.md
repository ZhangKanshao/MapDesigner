# MapDesigner

## 启动方式

在 Windows x64 或 ARM64 上，下载并解压完整项目，然后双击 `启动MapDesigner.cmd`。无需安装 Python、pip、Node.js 或 pnpm。

```bat
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-windows.ps1"
```

PowerShell 脚本检查本地 Electron，缺失时用 `curl.exe`（或 `Invoke-WebRequest`）从 GitHub 下载约 150 MB 的运行环境，校验 SHA-256 后解压到 `.cache/electron/`。随后在项目目录运行 `electron.exe .`。使用 `curl.exe` 下载中断时，再次双击可以续传。安装完成后可离线启动。

## 功能简介

- 使用 Crusader Kings III、Europa Universalis V、Victoria III 或 Hearts of Iron IV 底图，按不同区划粒度查询地名和绘制领土。
- 创建国家、指定首都、设置宗主与附庸关系和集团，调整国名、边界和地图风格。
- 保存和加载地图快照、导出整张地图为 PNG，或连接自行配置的 AI 服务讨论当前地图。
