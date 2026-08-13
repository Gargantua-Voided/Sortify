<#
.SYNOPSIS
    Shared helpers for Sortify Windows build scripts: version prompt and
    automatic npm dependency install (vite, esbuild, electron-builder, ...).
#>

function Install-SortifyBuildDependencies {
    param(
        [string]$RepoRoot = $PSScriptRoot
    )

    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) {
        Write-Host "npm is not installed or not in PATH. Install Node.js from https://nodejs.org/ then re-run this script." -ForegroundColor Red
        Read-Host -Prompt "Press Enter to exit"
        exit 1
    }

    $nodeModules = Join-Path $RepoRoot 'node_modules'
    $requiredPackages = @(
        'vite',
        'esbuild',
        'electron',
        'electron-builder',
        '@vitejs/plugin-react',
        '@tailwindcss/vite'
    )

    $missing = @()
    if (-not (Test-Path $nodeModules)) {
        $missing = $requiredPackages
    }
    else {
        foreach ($name in $requiredPackages) {
            $pkgJson = Join-Path $nodeModules ($name -replace '/', [IO.Path]::DirectorySeparatorChar)
            $pkgJson = Join-Path $pkgJson 'package.json'
            if (-not (Test-Path $pkgJson)) {
                $missing += $name
            }
        }
    }

    if ($missing.Count -eq 0) {
        Write-Host "Build dependencies already present (vite, esbuild, electron-builder)." -ForegroundColor DarkGray
        return
    }

    Write-Host "Missing packages: $($missing -join ', ')" -ForegroundColor Yellow
    Write-Host "Installing npm dependencies automatically..." -ForegroundColor Yellow
    Push-Location $RepoRoot
    try {
        npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Error "NPM install failed."
            Read-Host -Prompt "Press Enter to exit"
            exit $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }

    foreach ($name in $requiredPackages) {
        $pkgJson = Join-Path $nodeModules ($name -replace '/', [IO.Path]::DirectorySeparatorChar)
        $pkgJson = Join-Path $pkgJson 'package.json'
        if (-not (Test-Path $pkgJson)) {
            Write-Error "After npm install, still missing: $name"
            Read-Host -Prompt "Press Enter to exit"
            exit 1
        }
    }

    Write-Host "Dependencies installed." -ForegroundColor Green
}

function Get-SortifyBuildVersion {
    param(
        [string]$Default = '1.0.0',
        [int]$TimeoutSeconds = 3
    )

    Write-Host "Enter version number [$Default] (defaults in ${TimeoutSeconds}s if idle): " -NoNewline -ForegroundColor Yellow

    $inputBuilder = New-Object System.Text.StringBuilder
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    $timedOut = $false
    $startedTyping = $false

    while ($true) {
        while ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)

            if ($key.Key -eq 'Enter') {
                Write-Host ''
                $raw = $inputBuilder.ToString().Trim()
                if ([string]::IsNullOrWhiteSpace($raw)) {
                    Write-Host "Using default version $Default" -ForegroundColor DarkGray
                    return $Default
                }
                Write-Host "Using version $raw" -ForegroundColor DarkGray
                return $raw
            }

            if ($key.Key -eq 'Escape') {
                Write-Host ''
                Write-Host "Using default version $Default" -ForegroundColor DarkGray
                return $Default
            }

            if ($key.Key -eq 'Backspace') {
                if ($inputBuilder.Length -gt 0) {
                    [void]$inputBuilder.Remove($inputBuilder.Length - 1, 1)
                    Write-Host "`b `b" -NoNewline
                }
                continue
            }

            if ($null -ne $key.KeyChar -and -not [char]::IsControl($key.KeyChar)) {
                if (-not $startedTyping) {
                    $startedTyping = $true
                    $deadline = [datetime]::MaxValue
                }
                [void]$inputBuilder.Append($key.KeyChar)
                Write-Host $key.KeyChar -NoNewline
            }
        }

        if (-not $startedTyping -and [datetime]::UtcNow -ge $deadline) {
            $timedOut = $true
            break
        }

        Start-Sleep -Milliseconds 40
    }

    Write-Host ''
    if ($timedOut) {
        Write-Host "No input - using default version $Default" -ForegroundColor DarkGray
    }
    return $Default
}
