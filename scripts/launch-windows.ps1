$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$project = Split-Path -Parent $PSScriptRoot
$version = '42.11.15'
$checksums = @{
    x64   = 'f85fb7fb361508161bf0c3431e96518e34a9c10997048df21400a7da96658737'
    arm64 = '350a212a761650f8ff01393daf1f51787268ec6a6dd772616ab7ebc5dd46ba09'
}

function Test-ElectronRuntime($directory) {
    foreach ($file in 'electron.exe', 'icudtl.dat', 'resources.pak', 'version') {
        if (-not (Test-Path -LiteralPath (Join-Path $directory $file) -PathType Leaf)) { return $false }
    }
    $installed = (Get-Content -LiteralPath (Join-Path $directory 'version') -Raw).Trim()
    return ($installed -eq $version -or $installed -eq "v$version")
}

function Test-ArchiveHash($archive, $checksum) {
    if (-not [IO.File]::Exists($archive)) { return $false }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($archive)
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') -eq $checksum)
    } finally {
        $stream.Dispose()
        $sha256.Dispose()
    }
}

function Install-ElectronRuntime($cache, $asset, $checksum, $runtime) {
    $temporary = Join-Path $cache ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        $archive = Join-Path $cache "$asset.zip"
        if (-not (Test-ArchiveHash $archive $checksum)) {
            $partial = Join-Path $cache "$asset.zip.part"
            $url = "https://github.com/electron/electron/releases/download/v$version/$asset.zip"
            Write-Host "Downloading Electron $version from GitHub (about 150 MB)..."
            $curl = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
            if (Test-Path -LiteralPath $curl -PathType Leaf) {
                if (-not (Test-ArchiveHash $partial $checksum)) {
                    & $curl --fail --location --continue-at - --connect-timeout 15 --max-time 300 --progress-bar --output $partial $url
                    if ($LASTEXITCODE -in 33, 36) {
                        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
                        throw 'The previous download could not be resumed. Run the launcher to download again.'
                    }
                    if ($LASTEXITCODE -ne 0) { throw 'Electron download interrupted. Run the launcher again to resume.' }
                }
            } else {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $url -UseBasicParsing -OutFile $partial -TimeoutSec 300
            }
            if (-not (Test-ArchiveHash $partial $checksum)) {
                Remove-Item -LiteralPath $partial -Force
                throw 'The downloaded Electron archive failed SHA-256 verification.'
            }
            Move-Item -LiteralPath $partial -Destination $archive -Force
        }

        Write-Host 'Extracting the verified Electron runtime...'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $extracted = Join-Path $temporary 'runtime'
        [IO.Compression.ZipFile]::ExtractToDirectory($archive, $extracted)
        if (-not (Test-ElectronRuntime $extracted)) { throw 'The extracted Electron runtime is incomplete.' }

        if (Test-Path -LiteralPath $runtime) {
            Move-Item -LiteralPath $runtime -Destination (Join-Path $temporary 'old-runtime')
        }
        [IO.Directory]::Move($extracted, $runtime)
    } finally {
        # Only remove the directory created for this attempt, under the resolved cache.
        $resolved = (Resolve-Path -LiteralPath $temporary).ProviderPath
        if ((Split-Path -Parent $resolved) -eq $cache) {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Start-MapDesigner($executable, $directory) {
    if (-not ('MapDesigner.DetachedLauncher' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace MapDesigner {
    public static class DetachedLauncher {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo {
            public int cb;
            public string reserved, desktop, title;
            public int x, y, width, height, columns, rows, fillAttribute, flags;
            public short showWindow, reservedSize;
            public IntPtr reservedData, standardInput, standardOutput, standardError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInfo {
            public IntPtr process, thread;
            public int processId, threadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inheritHandles, uint flags,
            IntPtr environment, string directory, ref StartupInfo startup,
            out ProcessInfo process);

        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        public static void Start(string executable, string directory) {
            var startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(typeof(StartupInfo));
            ProcessInfo process;
            const uint DetachedProcess = 0x00000008;
            const uint NewProcessGroup = 0x00000200;
            // Keep Electron independent of the launcher's console and I/O handles.
            if (!CreateProcessW(executable, new StringBuilder("\"" + executable + "\" ."),
                IntPtr.Zero, IntPtr.Zero, false, DetachedProcess | NewProcessGroup,
                IntPtr.Zero, directory, ref startup, out process)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            CloseHandle(process.thread);
            CloseHandle(process.process);
        }
    }
}
'@
    }
    [MapDesigner.DetachedLauncher]::Start($executable, $directory)
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $project 'index.html') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $project 'electron/main.cjs') -PathType Leaf)) {
        throw 'Extract or clone the entire MapDesigner project before launching.'
    }
    $machine = $env:PROCESSOR_ARCHITEW6432
    if (-not $machine) { $machine = $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($machine) {
        AMD64 { 'x64' }
        ARM64 { 'arm64' }
        default { throw 'MapDesigner requires 64-bit Windows (x64 or ARM64).' }
    }

    $runtime = Join-Path $project 'node_modules/electron/dist'
    if (-not (Test-ElectronRuntime $runtime)) {
        $cache = Join-Path $project '.cache/electron'
        New-Item -ItemType Directory -Path $cache -Force | Out-Null
        $cache = (Resolve-Path -LiteralPath $cache).ProviderPath
        $asset = "electron-v$version-win32-$arch"
        $runtime = Join-Path $cache $asset
        $mutex = [Threading.Mutex]::new($false, "Local\MapDesigner-$asset")
        $locked = $false
        try {
            try {
                $locked = $mutex.WaitOne([TimeSpan]::FromMinutes(6))
            } catch [Threading.AbandonedMutexException] {
                $locked = $true
            }
            if (-not $locked) { throw 'Another launch is still preparing Electron. Please try again.' }
            if (-not (Test-ElectronRuntime $runtime)) {
                Install-ElectronRuntime $cache $asset $checksums[$arch] $runtime
            }
        } finally {
            if ($locked) { $mutex.ReleaseMutex() }
            $mutex.Dispose()
        }
    }

    Start-MapDesigner (Join-Path $runtime 'electron.exe') $project
} catch {
    Write-Host "MapDesigner could not start. $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
