Write-Host "Building Sortify Installer..." -ForegroundColor Cyan

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm is not installed or not in PATH." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
}

Write-Host "Building the React app and Electron scripts..." -ForegroundColor Yellow
npm run build

Write-Host "Packaging the application with Electron Builder..." -ForegroundColor Yellow
npx electron-builder --win --x64

Write-Host "Build complete! Check the release directory for the installer." -ForegroundColor Green
