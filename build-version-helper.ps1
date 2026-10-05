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
        Initialize-SortifyNativeBuildTools -RepoRoot $RepoRoot
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
    Initialize-SortifyNativeBuildTools -RepoRoot $RepoRoot
}

function Initialize-SortifyNativeBuildTools {
    param(
        [string]$RepoRoot = $PSScriptRoot
    )

    $electronExe = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path $electronExe)) {
        $electronInstall = Join-Path $RepoRoot 'node_modules\electron\install.js'
        if (-not (Test-Path $electronInstall)) {
            Write-Error "Electron is installed but install.js is missing."
            Read-Host -Prompt "Press Enter to exit"
            exit 1
        }
        Write-Host "Downloading the Electron runtime..." -ForegroundColor Yellow
        Push-Location $RepoRoot
        try {
            & node $electronInstall
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path $electronExe)) {
                Write-Error "Electron runtime install failed."
                Read-Host -Prompt "Press Enter to exit"
                exit 1
            }
        }
        finally {
            Pop-Location
        }
    }

    $esbuildExe = Join-Path $RepoRoot 'node_modules\@esbuild\win32-x64\esbuild.exe'
    if (-not (Test-Path $esbuildExe)) {
        $esbuildInstall = Join-Path $RepoRoot 'node_modules\esbuild\install.js'
        if (-not (Test-Path $esbuildInstall)) {
            Write-Error "esbuild is installed but install.js is missing."
            Read-Host -Prompt "Press Enter to exit"
            exit 1
        }
        Write-Host "Installing the esbuild binary..." -ForegroundColor Yellow
        Push-Location $RepoRoot
        try {
            & node $esbuildInstall
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path $esbuildExe)) {
                Write-Error "esbuild binary install failed."
                Read-Host -Prompt "Press Enter to exit"
                exit 1
            }
        }
        finally {
            Pop-Location
        }
    }
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

# electron-builder writes the project path, %TEMP%, and the electron-builder cache
# path into release/builder-debug.yml, and NSIS can embed those same paths in the
# installer stub. Stage the build on a drive-root folder that has no username.
function Initialize-SortifyNeutralBuildEnvironment {
    $root = Join-Path $env:SystemDrive 'SortifyBuild'
    $script:SortifyNeutralRoot = Join-Path $root 'src'
    $temp = Join-Path $root 'temp'
    $cache = Join-Path $root 'cache'

    New-Item -ItemType Directory -Force -Path $temp, $cache | Out-Null

    $env:TEMP = $temp
    $env:TMP = $temp
    $env:ELECTRON_BUILDER_CACHE = $cache

    Write-Host "Packaging from $script:SortifyNeutralRoot (temp and cache stay off your user profile)." -ForegroundColor DarkGray
}

function Sync-SortifyNeutralSource {
    param(
        [string]$RepoRoot = $PSScriptRoot
    )

    if (-not $script:SortifyNeutralRoot) {
        Initialize-SortifyNeutralBuildEnvironment
    }

    New-Item -ItemType Directory -Force -Path $script:SortifyNeutralRoot | Out-Null
    Write-Host "Copying project to a path that does not include your username..." -ForegroundColor Yellow

    # /XD matches the name anywhere, so a bare "release" also drops
    # node_modules\bluebird\js\release and electron-builder cannot start.
    $excludeDirs = @(
        (Join-Path $RepoRoot 'release'),
        (Join-Path $RepoRoot '.git')
    )
    & robocopy $RepoRoot $script:SortifyNeutralRoot /MIR /XD @excludeDirs /XF builder-debug.yml builder-effective-config.yaml /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Write-Error "Failed to copy the project to $($script:SortifyNeutralRoot) (robocopy exit $LASTEXITCODE)."
        Read-Host -Prompt "Press Enter to exit"
        exit $LASTEXITCODE
    }
}

function Assert-SortifyReleaseHasNoIdentityLeaks {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReleaseDir,
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    if (-not ('Sortify.ReleaseScan' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
namespace Sortify {
  public static class ReleaseScan {
    public static bool Contains(byte[] haystack, byte[] needle) {
      if (needle == null || needle.Length == 0 || haystack.Length < needle.Length) return false;
      int last = haystack.Length - needle.Length;
      for (int i = 0; i <= last; i++) {
        int j = 0;
        for (; j < needle.Length; j++) {
          if (haystack[i + j] != needle[j]) break;
        }
        if (j == needle.Length) return true;
      }
      return false;
    }
  }
}
'@
    }

    $needles = New-Object System.Collections.Generic.List[string]
    $profile = [Environment]::GetFolderPath('UserProfile')
    if (-not [string]::IsNullOrWhiteSpace($profile)) {
        $needles.Add($profile)
        $needles.Add(($profile -replace '\\', '/'))
    }

    $repoFull = (Resolve-Path $RepoRoot).Path
    $needles.Add($repoFull)
    $needles.Add(($repoFull -replace '\\', '/'))

    $user = $env:USERNAME
    if (-not [string]::IsNullOrWhiteSpace($user)) {
        $needles.Add("\Users\$user")
        $needles.Add("/Users/$user")
    }

    $variants = New-Object System.Collections.Generic.List[string]
    foreach ($needle in $needles) {
        if ([string]::IsNullOrWhiteSpace($needle)) { continue }
        foreach ($variant in @($needle, $needle.ToLowerInvariant(), $needle.ToUpperInvariant())) {
            if (-not $variants.Contains($variant)) {
                $variants.Add($variant)
            }
        }
    }

    $extensions = @('.exe', '.asar', '.yml', '.yaml', '.json', '.js', '.cjs', '.html', '.txt', '.nsh', '.ps1', '.blockmap')
    $files = @(Get-ChildItem -Path $ReleaseDir -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
        $extensions -contains $_.Extension.ToLowerInvariant()
    })

    $utf8 = [System.Text.Encoding]::UTF8
    $unicode = [System.Text.Encoding]::Unicode

    foreach ($file in $files) {
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        foreach ($variant in $variants) {
            $found = [Sortify.ReleaseScan]::Contains($bytes, $utf8.GetBytes($variant)) -or
                [Sortify.ReleaseScan]::Contains($bytes, $unicode.GetBytes($variant))
            if ($found) {
                Write-Error "Ship check failed: $($file.FullName) still contains this machine's user or project path ($variant)."
                Read-Host -Prompt "Press Enter to exit"
                exit 1
            }
        }
    }

    Write-Host "Ship check passed: installer output has no user profile or project path." -ForegroundColor Green
}

function Publish-SortifyCleanRelease {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $stagedRelease = Join-Path $script:SortifyNeutralRoot 'release'
    if (-not (Test-Path $stagedRelease)) {
        Write-Error "electron-builder did not produce $stagedRelease."
        Read-Host -Prompt "Press Enter to exit"
        exit 1
    }

    Get-ChildItem -Path $stagedRelease -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in @('builder-debug.yml', 'builder-effective-config.yaml') } |
        Remove-Item -Force

    Assert-SortifyReleaseHasNoIdentityLeaks -ReleaseDir $stagedRelease -RepoRoot $RepoRoot

    $dest = Join-Path $RepoRoot 'release'
    if (Test-Path $dest) {
        Remove-Item -Recurse -Force $dest
    }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null

    Get-ChildItem -Path $stagedRelease -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $dest $_.Name) -Recurse -Force
    }

    Write-Host "Copied shippable artifacts to $dest (builder-debug.yml omitted)." -ForegroundColor Green
}

function Invoke-SortifyElectronBuilder {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$BuilderArgs,
        [string]$RepoRoot = $PSScriptRoot
    )

    Initialize-SortifyNeutralBuildEnvironment
    Sync-SortifyNeutralSource -RepoRoot $RepoRoot

    $stagedRelease = Join-Path $script:SortifyNeutralRoot 'release'
    if (Test-Path $stagedRelease) {
        Remove-Item -Recurse -Force $stagedRelease
    }

    Push-Location $script:SortifyNeutralRoot
    try {
        & npx electron-builder @BuilderArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Electron builder failed."
            Read-Host -Prompt "Press Enter to exit"
            exit $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }

    Publish-SortifyCleanRelease -RepoRoot $RepoRoot
}
