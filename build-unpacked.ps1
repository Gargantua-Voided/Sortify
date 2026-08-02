<#
.SYNOPSIS
    Build an unpacked Windows app into release/win-unpacked.
#>

Write-Host "Building Sortify Unpacked..." -ForegroundColor Cyan

. "$PSScriptRoot\build-version-helper.ps1"
$version = Get-SortifyBuildVersion

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

Write-Host "Creating unpacked Electron build in 'release' folder (v$version)..." -ForegroundColor Yellow
Write-Host "Code signing disabled (unsigned local builds)." -ForegroundColor DarkGray
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npx electron-builder --win dir --x64 "-c.extraMetadata.version=$version"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Electron builder failed."
    Read-Host -Prompt "Press Enter to exit"
    exit $LASTEXITCODE
}

Write-Host "Build complete! Unpacked application is in the 'release' folder (v$version)." -ForegroundColor Green
exit 0
