<#
.SYNOPSIS
    Prompt for a build version. Empty Enter or 3s with no input -> 1.0.0.
    Once the user starts typing, wait indefinitely for Enter.
#>
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
