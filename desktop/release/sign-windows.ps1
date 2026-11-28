# Sign the Windows builds with Authenticode and a timestamp (W1). Run on the Windows PC that has the signing setup.
#   powershell -File desktop\release\sign-windows.ps1 -Dir dist-desktop\<version> [-Dlib <Azure.CodeSigning.Dlib.dll> -Metadata <metadata.json>]
# Azure Trusted Signing: pass -Dlib and -Metadata (account + profile names only; you sign in with az login yourself).
# Certificate in the Windows certificate store: leave them out; signtool picks the KoAjent LLC code-signing certificate.
param([Parameter(Mandatory)][string]$Dir, [string]$Dlib, [string]$Metadata)
$ErrorActionPreference = 'Stop'
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found (install the Windows SDK).' }
foreach ($zip in Get-ChildItem $Dir -Filter 'Parano1d-World-Wallet-*-windows-*.zip') {
  $w = Join-Path $env:TEMP ([guid]::NewGuid()); Expand-Archive $zip.FullName $w
  $files = Get-ChildItem $w -Recurse -Include *.exe, *.dll | ForEach-Object FullName
  $sa = @('sign', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256')
  if ($Dlib) { $sa += @('/dlib', $Dlib, '/dmdf', $Metadata) } else { $sa += @('/n', 'KoAjent LLC') }
  & $signtool.FullName @sa @files; if ($LASTEXITCODE) { throw 'signing failed' }
  foreach ($f in $files) { $s = Get-AuthenticodeSignature $f; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=KoAjent LLC') { throw "not validly signed: $f" } }
  Remove-Item $zip.FullName; Compress-Archive "$w\*" $zip.FullName; Remove-Item $w -Recurse -Force
  Write-Host "Signed: $($zip.Name)"
}
node (Join-Path $PSScriptRoot 'package-release.mjs') --sums $Dir
