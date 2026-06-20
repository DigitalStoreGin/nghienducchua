# Dong goi ban phat hanh CO SAN Whisper de gui khach. Chay 1 lan tren may ban.
# Cach dung: chuot phai -> Run with PowerShell, hoac:
#   powershell -ExecutionPolicy Bypass -File build-release.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$V = "2.17.2"
$B = "https://cdn.jsdelivr.net/npm/@xenova/transformers@$V/dist"

Write-Host "[1/3] Tai thu vien Whisper vao vendor/ ..."
Invoke-WebRequest "$B/transformers.min.js" -OutFile "vendor/transformers.min.js"
foreach ($f in @("ort-wasm.wasm","ort-wasm-simd.wasm","ort-wasm-threaded.wasm","ort-wasm-simd-threaded.wasm")) {
  try { Invoke-WebRequest "$B/$f" -OutFile "vendor/$f" } catch { Write-Host "   (bo qua $f)" }
}

Write-Host "[2/3] Don file khong can dong goi ..."
$stage = Join-Path $env:TEMP "shadowing-release"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
$dest = Join-Path $stage "shadowing-extension"
Copy-Item -Recurse -Path $here -Destination $dest
Remove-Item -Recurse -Force (Join-Path $dest "tests") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $dest "*.zip") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $dest ".gitignore") -ErrorAction SilentlyContinue

Write-Host "[3/3] Nen thanh shadowing-extension-release.zip ..."
$out = Join-Path $here "shadowing-extension-release.zip"
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path (Join-Path $stage "shadowing-extension") -DestinationPath $out
Write-Host "XONG -> $out"
Write-Host "Gui file nay cho khach (hoac upload len Chrome Web Store). Khach KHONG can chay script."
