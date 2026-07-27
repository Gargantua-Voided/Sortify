Write-Host "Building Sortify Installer..." -ForegroundColor Cyan

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm is not installed or not in PATH." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Error "NPM install failed."
        exit $LASTEXITCODE
    }
}

Write-Host "Building the React app and Electron scripts..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "App build failed."
    exit $LASTEXITCODE
}

Write-Host "Packaging the application with Electron Builder..." -ForegroundColor Yellow
Write-Host "NSIS one-click is disabled - the installer will let users choose the install directory." -ForegroundColor DarkGray
npx electron-builder --win --x64
if ($LASTEXITCODE -ne 0) {
    Write-Error "Electron builder failed."
    exit $LASTEXITCODE
}

Write-Host "Build complete! Check the release directory for the installer." -ForegroundColor Green
