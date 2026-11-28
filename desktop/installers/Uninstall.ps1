# Removes the Parano1d World Desktop Wallet program, shortcuts and Apps entry for this Windows user.
# Your encrypted wallet data is KEPT unless you add -RemoveWalletData (only after backing up your master key).
param([switch]$RemoveWalletData)
$ErrorActionPreference = 'SilentlyContinue'
$AppName = 'Parano1d World Wallet'
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\Parano1dWorldWallet'
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($Dest, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk") -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk") -Force
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Parano1dWorldWallet' -Recurse -Force
$data = Join-Path $env:APPDATA $AppName
if ($RemoveWalletData) { Remove-Item $data -Recurse -Force; Write-Host '  Wallet data on this computer removed.' }
elseif (Test-Path $data) { Write-Host "  Your encrypted wallet data was kept in $data (reinstalling opens it again)." }
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', "Start-Sleep 2; Remove-Item -LiteralPath '$Dest' -Recurse -Force"
Write-Host '  Parano1d World Wallet removed.'
