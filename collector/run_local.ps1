# One collection cycle, run by the scheduled task.
#
# Collecting and publishing run on different clocks on purpose. The source
# recomputes its counters every five minutes, so that is how often we read it;
# but GitHub Pages has a soft limit of ten builds an hour, and every push
# triggers one. So samples accumulate locally and go out in one commit roughly
# every quarter of an hour - three readings per commit, four pushes an hour.
#
# Why this runs here and not in GitHub Actions: eso.lt sits behind Cloudflare,
# which answers datacenter IPs with the "Just a moment..." JS challenge. A home
# connection is served normally.

[CmdletBinding()]
param(
    # Collect and commit, but do not push. For trying the script out.
    [switch]$NoPush,
    # Publish when the last data commit is at least this old. Slightly under a
    # quarter of an hour so the third five-minute run reliably triggers it.
    [int]$PublishAfterSeconds = 840
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

# Keep the log from growing without bound (~4 days of five-minute runs).
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 512KB)) {
    $tail = Get-Content $logFile -Tail 1000
    Set-Content -Path $logFile -Value $tail -Encoding utf8
}

Push-Location $repo
try {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { throw 'python not found on PATH' }

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

    # How long since the history was last published?
    $lastPublish = git log -1 --format=%ct -- docs/data
    $age = if ($lastPublish) {
        [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int]$lastPublish)
    } else {
        [int]::MaxValue
    }

    if (-not $NoPush -and $age -lt $PublishAfterSeconds) {
        Write-Log ('снимок записан, публикация через {0} с' -f ($PublishAfterSeconds - $age))
        exit 0
    }

    # Rebase now rather than every run: the only reason to talk to GitHub is
    # that we are about to push. --autostash carries the pending rows across.
    git pull --rebase --autostash --quiet origin main
    if (-not $?) { Write-Log 'git pull --rebase failed; continuing with local state' 'warn' }

    $added = 0
    foreach ($line in (git diff --numstat -- docs/data)) {
        $parts = $line -split "`t"
        if ($parts.Count -ge 3 -and $parts[2] -like '*.csv') { $added += [int]$parts[0] }
    }

    git add docs/data
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm')
    git commit --quiet -m ('data: {0} snapshot(s) up to {1} UTC' -f $added, $stamp)
    if (-not $?) { throw 'git commit failed' }

    if ($NoPush) {
        Write-Log ('committed {0} snapshot(s); push skipped (-NoPush)' -f $added)
        exit 0
    }

    git push --quiet origin main
    if (-not $?) {
        # Not fatal: the next run rebases and pushes everything at once.
        Write-Log 'git push failed; will retry on the next run' 'warn'
        exit 0
    }
    Write-Log ('опубликовано снимков: {0}' -f $added)
}
catch {
    Write-Log $_.Exception.Message 'error'
    exit 1
}
finally {
    Pop-Location
}
