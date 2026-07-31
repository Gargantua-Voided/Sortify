<#
.SYNOPSIS
    Build a portable single-exe Windows package (no install required).
#>

Write-Host "Building Sortify Portable..." -ForegroundColor Cyan

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm is not installed or not in PATH." -ForegroundColor Red
    Read-Host -Prompt "Press Enter to exit"
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Error "NPM install failed."
        Read-Host -Prompt "Press Enter to exit"
        exit $LASTEXITCODE
    }
}

Write-Host "Building the React app and Electron scripts..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "App build failed."
    Read-Host -Prompt "Press Enter to exit"
    exit $LASTEXITCODE
}

if (Test-Path "release") {
    Write-Host "Cleaning previous release/ folder..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force "release"
}

Write-Host "Packaging portable build with Electron Builder..." -ForegroundColor Yellow
Write-Host "Code signing disabled (unsigned local builds)." -ForegroundColor DarkGray
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npx electron-builder --win portable --x64
if ($LASTEXITCODE -ne 0) {
    Write-Error "Electron builder failed."
    Read-Host -Prompt "Press Enter to exit"
    exit $LASTEXITCODE
}

Write-Host "Build complete! Portable exe is in the release directory." -ForegroundColor Green
exit 0
