# Parano1d World Desktop Wallet - Windows installer.
# Downloads the official Electron runtime from GitHub, checks its SHA-256 against the value pinned below, adds the
# Parano1d World Wallet app (also hash-checked), locks the runtime down (Electron fuses) and creates shortcuts.
# Installs for the current Windows user only. Nothing here needs, asks for or touches a wallet key.
param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ElectronVersion = '__ELECTRON_VERSION__'
$Pins = @{ 'x64' = '__SHA_WIN_X64__'; 'arm64' = '__SHA_WIN_ARM64__' }
$AppAsarSha = '__APP_ASAR_SHA__'
$AppName = 'Parano1d World Wallet'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-ChildItem -LiteralPath $Here -File | Unblock-File -ErrorAction SilentlyContinue
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\Parano1dWorldWallet'
function Say($m) { Write-Host "  $m" }
function Fail($m) { Write-Host ""; Write-Host "  Installation stopped: $m" -ForegroundColor Red; if (-not $Quiet) { Read-Host '  Press Enter to close' | Out-Null }; exit 1 }

Write-Host ""; Write-Host "  Parano1d World Desktop Wallet" -ForegroundColor Green; Write-Host ""
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
if (-not [Environment]::Is64BitOperatingSystem) { Fail '64-bit Windows 10 or 11 is required.' }
$asar = Join-Path $Here 'app.asar'
if (-not (Test-Path $asar)) { Fail 'app.asar is missing. Extract the whole download first, then run Install.cmd from that folder.' }
if ((Get-FileHash $asar -Algorithm SHA256).Hash.ToLower() -ne $AppAsarSha) { Fail 'The wallet app file does not match its published checksum. Download it again from parano1dworld.com.' }

$tmp = Join-Path $env:TEMP ("p1w-desktop-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'electron.zip'
  $url = "https://github.com/electron/electron/releases/download/v$ElectronVersion/electron-v$ElectronVersion-win32-$arch.zip"
  Say "Downloading the official Electron $ElectronVersion runtime ($arch) from GitHub..."
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  Say 'Checking its SHA-256...'
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $Pins[$arch]) { Fail 'The runtime download does not match the pinned checksum. Nothing was installed.' }
  $stage = Join-Path $tmp 'app'
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  Remove-Item (Join-Path $stage 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue
  Copy-Item $asar (Join-Path $stage 'resources\app.asar') -Force
  Copy-Item (Join-Path $Here 'icon.ico') (Join-Path $stage 'icon.ico') -Force
  Copy-Item (Join-Path $Here 'Uninstall.ps1') (Join-Path $stage 'Uninstall.ps1') -Force
  Rename-Item (Join-Path $stage 'electron.exe') "$AppName.exe"

  # Lock the runtime down: it can't be used as a Node.js interpreter, ignores NODE_OPTIONS and --inspect,
  # only runs the app.asar we installed, encrypts its cookies and gets no extra file:// privileges.
  Say 'Locking the runtime down...'
  $exe = Join-Path $stage "$AppName.exe"
  $bytes = [IO.File]::ReadAllBytes($exe)
  $latin = [Text.Encoding]::GetEncoding(28591).GetString($bytes)
  $i = $latin.IndexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', [StringComparison]::Ordinal)
  if ($i -lt 0) { Fail 'Could not find the runtime security switches. Nothing was installed.' }
  $wire = $i + 32
  if ($bytes[$wire] -ne 1) { Fail 'Unexpected runtime security layout. Nothing was installed.' }
  $len = $bytes[$wire + 1]; $f = $wire + 2
  $set = @{ 0 = 48; 1 = 49; 2 = 48; 3 = 48; 5 = 49; 7 = 48 }
  foreach ($k in $set.Keys) { if ($k -lt $len -and $bytes[$f + $k] -ne 114) { $bytes[$f + $k] = [byte]$set[$k] } }
  [IO.File]::WriteAllBytes($exe, $bytes)

  # Update without breaking a working install: the new copy is fully built and checked first, then swapped in.
  # If the swap fails, the previous version is put back. Wallet data lives elsewhere and is never touched.
  if (-not (Test-Path (Join-Path $stage "$AppName.exe")) -or -not (Test-Path (Join-Path $stage 'resources\app.asar'))) { Fail 'The new copy is incomplete. Your current install was not changed.' }
  New-Item -ItemType Directory -Path (Split-Path $Dest) -Force | Out-Null
  # Only now close a running copy (Windows can't move files in use), so the app stays usable during the download.
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Dest, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  $old = "$Dest.previous"
  Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $Dest) { try { Rename-Item $Dest (Split-Path $old -Leaf) } catch { Fail 'The current version is still in use (close Parano1d World Wallet and any window showing its folder), then run Install.cmd again. Nothing was changed.' } }
  try { Move-Item $stage $Dest }
  catch { if (Test-Path $old) { Rename-Item $old (Split-Path $Dest -Leaf) }; Fail "Could not put the new version in place ($($_.Exception.Message)). Your previous version was restored." }
  Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

# Shortcuts and the Windows Apps entry (current user only).
$exe = Join-Path $Dest "$AppName.exe"; $ico = Join-Path $Dest 'icon.ico'
$sh = New-Object -ComObject WScript.Shell
foreach ($lnk in @((Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"), (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"))) {
  $s = $sh.CreateShortcut($lnk); $s.TargetPath = $exe; $s.WorkingDirectory = $Dest; $s.IconLocation = "$ico,0"; $s.Description = 'Parano1d World Desktop Wallet'; $s.Save()
}
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Parano1dWorldWallet'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty $key DisplayName $AppName
Set-ItemProperty $key DisplayVersion '__APP_VERSION__'
Set-ItemProperty $key Publisher 'Parano1d World'
Set-ItemProperty $key DisplayIcon $ico
Set-ItemProperty $key InstallLocation $Dest
Set-ItemProperty $key URLInfoAbout 'https://parano1dworld.com/desktop-wallet'
Set-ItemProperty $key NoModify 1 -Type DWord; Set-ItemProperty $key NoRepair 1 -Type DWord
Set-ItemProperty $key UninstallString ("powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"" + (Join-Path $Dest 'Uninstall.ps1') + "`"")
Write-Host ""; Say "Installed. Open '$AppName' from the Start menu or your Desktop."
Say 'Your wallet stays on this computer, encrypted with your password. Back up your master key.'
if (-not $Quiet) { Start-Process $exe; Start-Sleep 1 }
