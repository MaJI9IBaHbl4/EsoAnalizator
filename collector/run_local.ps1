# One collection cycle, run by the scheduled task: take a snapshot, commit it,
# push it. Everything is logged to collector/run.log (gitignored).
#
# Why this runs here and not in GitHub Actions: eso.lt sits behind Cloudflare,
# which answers datacenter IPs with the "Just a moment..." JS challenge. A home
# connection is served normally.

[CmdletBinding()]
param(
    # Collect and commit, but do not push. For trying the script out.
    [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $PSScriptRoot 'run.log'

function Write-Log {
    param([string]$Message, [string]$Level = 'info')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -Path $logFile -Value $line -Encoding utf8
    Write-Host $line
}

# Keep the log from growing without bound (~2 weeks of 15-minute runs).
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 512KB)) {
    $tail = Get-Content $logFile -Tail 1000
    Set-Content -Path $logFile -Value $tail -Encoding utf8
}

Push-Location $repo
try {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { throw 'python not found on PATH' }

    # Rebase first: a run whose push failed earlier leaves local commits, and a
    # manual commit may have landed on the remote meanwhile.
    git pull --rebase --autostash --quiet origin main
    if (-not $?) { Write-Log 'git pull --rebase failed; continuing with local state' 'warn' }

    $output = & $python (Join-Path $PSScriptRoot 'collect.py') 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log ("collect.py exited $LASTEXITCODE : " + ($output -join ' | ')) 'error'
        exit 1
    }
    Write-Log ($output -join ' | ')

    if (-not (git status --porcelain docs/data)) {
        Write-Log 'no change to commit' 'warn'
        exit 0
    }

    git add docs/data
    git commit --quiet -m ('data: snapshot {0} UTC' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm'))
    if (-not $?) { throw 'git commit failed' }

    if ($NoPush) {
        Write-Log 'committed; push skipped (-NoPush)'
        exit 0
    }

    git push --quiet origin main
    if (-not $?) {
        # Not fatal: the next run rebases and pushes both snapshots.
        Write-Log 'git push failed; will retry on the next run' 'warn'
        exit 0
    }
    Write-Log 'committed and pushed'
}
catch {
    Write-Log $_.Exception.Message 'error'
    exit 1
}
finally {
    Pop-Location
}
