Add-Type -AssemblyName System.Drawing
$src = "C:\Users\pbjus\Downloads\ARCANOS-Windows\ARCANOS-Setup.exe"
$dest = (Join-Path $PSScriptRoot "..\arcanos\assets\icon.ico")
if (-not (Test-Path $src)) { Write-Host "SOURCE_NOT_FOUND"; exit 2 }
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($src)
$fs = [System.IO.File]::Create($dest)
$icon.Save($fs)
$fs.Close()
$fs.Dispose()
Write-Host "OK"
