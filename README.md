# MapDesigner

## 启动方式

在 Windows x64 或 ARM64 上下载并解压完整项目，然后任选一种方式启动：

1. 双击项目目录中的 `启动MapDesigner.cmd`。
2. 在项目目录打开 PowerShell，执行与 `.cmd` 等效的命令：

   ```powershell
   & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\scripts\launch-windows.ps1"
   ```

`.cmd` 会自动调用 PowerShell 脚本。两种启动方式都会自动完成下面的步骤，无需手动执行，也无需安装 Python、pip、Node.js 或 pnpm。

1. 检查本地 Electron。缺失时从 GitHub 下载约 150 MB 的运行环境，校验 SHA-256 后解压到 `.cache/electron/`。
2. 在项目目录运行 `electron.exe .`，打开 MapDesigner。配置完成后可离线启动。

## 功能简介

- 使用 Crusader Kings III、Europa Universalis V、Victoria III 或 Hearts of Iron IV 底图，按不同区划粒度查询地名和绘制领土。
- 创建国家、指定首都、设置宗主与附庸关系和集团，调整国名、边界和地图风格。
- 保存和加载地图快照、导出整张地图为 PNG，或连接自行配置的 AI 服务讨论当前地图。
