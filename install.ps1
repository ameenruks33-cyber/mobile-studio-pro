# Mobile Studio Pro installer
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ExpectedHash = "3238EFF98C78EFE025CB9518B8E50FD6223EC3E7079DC82C97B319AB1B3054A2"
$Urls = @(
  "https://github.com/ameenruks33-cyber/mobile-studio-pro/releases/latest/download/MobileStudioPro.exe",
  "https://ameenruks33-cyber.github.io/mobile-studio-pro/MobileStudioPro.exe"
)

$InstallDir = Join-Path $env:LOCALAPPDATA "MobileStudioPro"
$ExePath = Join-Path $InstallDir "MobileStudioPro.exe"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$temp = Join-Path $env:TEMP "MobileStudioPro-setup.exe"
$downloaded = $false
foreach ($url in $Urls) {
  try {
    Write-Host "Downloading Mobile Studio Pro..."
    Invoke-WebRequest -Uri $url -OutFile $temp -UseBasicParsing
    $downloaded = $true
    break
  } catch {
    Write-Host "Retrying from backup URL..."
  }
}

if (-not $downloaded -or -not (Test-Path $temp)) {
  throw "Download failed. Open https://ameenruks33-cyber.github.io/mobile-studio-pro/ and use Download for Windows."
}

$hash = (Get-FileHash $temp -Algorithm SHA256).Hash
if ($hash -ne $ExpectedHash) {
  Remove-Item $temp -Force -ErrorAction SilentlyContinue
  throw "File hash mismatch. Install stopped."
}

Copy-Item -Force $temp $ExePath
Remove-Item $temp -Force -ErrorAction SilentlyContinue

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$start = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"

foreach ($folder in @($desktop, $start)) {
  $shortcut = $shell.CreateShortcut((Join-Path $folder "Mobile Studio Pro.lnk"))
  $shortcut.TargetPath = $ExePath
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.Description = "Mobile Studio Pro"
  $shortcut.Save()
}

Write-Host "Installed to $ExePath"
Start-Process $ExePath
