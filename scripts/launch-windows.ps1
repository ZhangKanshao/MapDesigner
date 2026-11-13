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

function Install-ElectronRuntime($cache, $asset, $checksum, $runtime) {
    $temporary = Join-Path $cache ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        $archive = Join-Path $cache "$asset.zip"
        if (-not (Test-Path -LiteralPath $archive -PathType Leaf) -or
            (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $checksum) {
            $archive = Join-Path $temporary "$asset.zip"
            $url = "https://github.com/electron/electron/releases/download/v$version/$asset.zip"
            Write-Host "Downloading Electron $version from GitHub (about 150 MB)..."
            $curl = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
            if (Test-Path -LiteralPath $curl -PathType Leaf) {
                & $curl --fail --location --retry 1 --connect-timeout 15 --max-time 240 --progress-bar --output $archive $url
                if ($LASTEXITCODE -ne 0) { throw 'Electron download failed. Check your GitHub connection and try again.' }
            } else {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $url -UseBasicParsing -OutFile $archive -TimeoutSec 300
            }
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $checksum) {
                throw 'The downloaded Electron archive failed SHA-256 verification.'
            }
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

    Start-Process -FilePath (Join-Path $runtime 'electron.exe') -ArgumentList '.' -WorkingDirectory $project
} catch {
    Write-Host "MapDesigner could not start. $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
