# ============================================================
# Builds Pie Timers as a Windows screen saver and sets it as active.
#
# Run from a normal (non-admin) PowerShell window, from this folder:
#   .\install.ps1
#
# Everything here is per-user (HKCU) and needs no admin rights -- the
# .scr file is never copied into System32; Windows is told to run it
# from wherever it sits via the SCRNSAVE.EXE registry value, which is
# officially supported and is exactly how "Browse..." in the Screen
# Saver Settings dialog behaves internally.
# ============================================================

$ErrorActionPreference = "Stop"

function Find-Dotnet {
    $candidates = @(
        "$env:USERPROFILE\dotnet-sdk\dotnet.exe",
        "dotnet.exe"
    )
    foreach ($c in $candidates) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        if (Test-Path $c) { return $c }
    }
    return $null
}

$dotnet = Find-Dotnet
if (-not $dotnet) {
    Write-Host "No .NET SDK found. Install it first -- no admin rights needed:" -ForegroundColor Yellow
    Write-Host '  Invoke-WebRequest "https://dot.net/v1/dotnet-install.ps1" -OutFile "$env:TEMP\dotnet-install.ps1"'
    Write-Host '  & "$env:TEMP\dotnet-install.ps1" -Channel 8.0 -InstallDir "$env:USERPROFILE\dotnet-sdk" -NoPath'
    exit 1
}

Write-Host "Building..." -ForegroundColor Cyan
& $dotnet publish -c Release -r win-x64 --self-contained true --nologo -v quiet
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed."; exit 1 }

$publishDir = Join-Path $PSScriptRoot "bin\Release\net8.0-windows\win-x64\publish"
$exePath = Join-Path $publishDir "PieTimersScreensaver.exe"
$scrPath = Join-Path $publishDir "PieTimersScreensaver.scr"

if (-not (Test-Path $exePath)) {
    Write-Error "Build succeeded but $exePath is missing -- something's wrong with the publish output."
    exit 1
}

Copy-Item $exePath $scrPath -Force
$fullScrPath = (Resolve-Path $scrPath).Path

Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name "SCRNSAVE.EXE" -Value $fullScrPath
Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaveActive" -Value "1"
if (-not (Get-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaveTimeOut" -ErrorAction SilentlyContinue)) {
    Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaveTimeOut" -Value "600"
}

Write-Host ""
Write-Host "Done. Pie Timers is now your screen saver." -ForegroundColor Green
Write-Host "File: $fullScrPath"
Write-Host ""
Write-Host "Worth checking once, right now:" -ForegroundColor Yellow
Write-Host "  1. Settings -> Personalisation -> Lock screen -> Screen saver settings"
Write-Host "     -- click Preview to see it full screen."
Write-Host "  2. Move the mouse or press a key to confirm it closes."
Write-Host "     (This is the one thing worth double-checking yourself -- see README.md.)"
