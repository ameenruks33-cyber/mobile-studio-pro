# Save this file, then run: powershell -File install.ps1
# Do not pipe random web scripts into iex.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Base = "https://ameenruks33-cyber.github.io/mobile-studio-pro"
$InstallDir = Join-Path $env:LOCALAPPDATA "MobileStudioPro"
$ExePath = Join-Path $InstallDir "MobileStudioPro.exe"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$sumText = (Invoke-WebRequest -Uri "$Base/SHA256SUMS.txt" -UseBasicParsing).Content
$expected = ($sumText -split "\s+")[0].Trim().ToUpperInvariant()
if ($expected.Length -ne 64) { throw "Could not read published SHA256." }

$temp = Join-Path $env:TEMP "MobileStudioPro-setup.exe"
$urls = @(
  "https://github.com/ameenruks33-cyber/mobile-studio-pro/releases/latest/download/MobileStudioPro.exe",
  "$Base/MobileStudioPro.exe"
)
$ok = $false
foreach ($url in $urls) {
    try {
        Invoke-WebRequest -Uri $url -OutFile $temp -UseBasicParsing
        $ok = $true
        break
    } catch { }
}
if (-not $ok) { throw "Download failed." }

$actual = (Get-FileHash $temp -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actual -ne $expected) {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
    throw "SHA256 mismatch. Install stopped."
}

Copy-Item -Force $temp $ExePath
Remove-Item $temp -Force -ErrorAction SilentlyContinue
Unblock-File -Path $ExePath -ErrorAction SilentlyContinue

try {
    Invoke-WebRequest -Uri "$Base/MobileStudioPro.cer" -OutFile (Join-Path $InstallDir "MobileStudioPro.cer") -UseBasicParsing
    Import-Certificate -FilePath (Join-Path $InstallDir "MobileStudioPro.cer") -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
} catch { }

$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath("Desktop"), (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"))) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder "Mobile Studio Pro.lnk"))
    $shortcut.TargetPath = $ExePath
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.Description = "Mobile Studio Pro"
    $shortcut.IconLocation = "$ExePath,0"
    $shortcut.Save()
}

Write-Host "Installed and unblocked: $ExePath"
Start-Process $ExePath
