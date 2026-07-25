<#
.SYNOPSIS
    Build script for the Electron + Vite + React Auto Package Analyzer.
.DESCRIPTION
    This script builds the Vite frontend and the Electron backend, then
    runs electron-builder to output the unpacked files into a 'release' folder.
#>

param(
    [switch]$Pack = $false
)

Write-Host "Starting build process..." -ForegroundColor Cyan

# Ensure dependencies are installed
Write-Host "Installing NPM dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Error "NPM install failed."
    Read-Host -Prompt "Press Enter to exit"
    exit $LASTEXITCODE
}

# Build the Vite React frontend and Express backend (or Electron backend in this case)
Write-Host "Building React frontend and backend..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Vite/Backend build failed."
    Read-Host -Prompt "Press Enter to exit"
    exit $LASTEXITCODE
}

# Run electron-builder for an unpacked build into a 'release' directory
Write-Host "Creating unpacked Electron build in 'release' folder..."
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npx electron-builder --win dir --x64
if ($LASTEXITCODE -ne 0) {
    Write-Error "Electron builder failed."
    Read-Host -Prompt "Press Enter to exit"
    exit $LASTEXITCODE
}

Write-Host "Build complete! Unpacked application is in the 'release' folder." -ForegroundColor Green
Write-Host ""
Read-Host -Prompt "Press Enter to exit"
