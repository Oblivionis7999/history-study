param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskRuntime = Join-Path $taskRoot '.runtime'
$taskPidFile = Join-Path $taskRuntime 'local-preview-processes.json'
function Stop-PreviewTree {
    param([int]$TaskProcessId, [long]$ExpectedTicks)
    $taskLiveProcess = Get-Process -Id $TaskProcessId -ErrorAction SilentlyContinue
    if (-not $taskLiveProcess -or $taskLiveProcess.StartTime.ToUniversalTime().Ticks -ne $ExpectedTicks) { return }
    # The venv launcher can create a child Python process on Windows.
    $taskChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId=$TaskProcessId"
    foreach ($taskChild in $taskChildren) {
        $taskChildProcess = Get-Process -Id $taskChild.ProcessId -ErrorAction SilentlyContinue
        if ($taskChildProcess) { Stop-PreviewTree -TaskProcessId $taskChildProcess.Id -ExpectedTicks $taskChildProcess.StartTime.ToUniversalTime().Ticks }
    }
    Stop-Process -Id $TaskProcessId -ErrorAction SilentlyContinue
}
if ($Stop) {
    if (Test-Path -LiteralPath $taskPidFile) {
        $taskProcesses = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
        foreach ($taskEntry in $taskProcesses) {
            Stop-PreviewTree -TaskProcessId $taskEntry.id -ExpectedTicks ([long]$taskEntry.started_ticks)
        }
        Remove-Item -LiteralPath $taskPidFile
    }
    Write-Host '本地预览已停止。'
    exit
}
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw '请先按 README 创建 .venv 并安装依赖。' }
$taskNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $taskNode -or -not (Test-Path -LiteralPath $taskNode)) { throw '请先安装 Node.js，并将 node 加入 PATH。' }
foreach ($taskPort in @(8765,5173)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $taskPort -ErrorAction SilentlyContinue) { throw "端口 $taskPort 已占用，请先关闭已有预览。" }
}
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
$taskPreviousDev = $env:DEV_MODE
$taskPreviousDB = $env:AUTH_DATABASE_PATH
$taskEntries = @()
try {
    $env:DEV_MODE = '1'
    $env:AUTH_DATABASE_PATH = Join-Path $taskRuntime 'accounts.sqlite'
    $taskAPI = Start-Process -FilePath $taskPython -ArgumentList @('-m','uvicorn','backend.app:app','--host','127.0.0.1','--port','8765','--no-proxy-headers') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRuntime 'local-api.log') -RedirectStandardError (Join-Path $taskRuntime 'local-api-error.log')
    $taskEntries += @{ id=$taskAPI.Id; started_ticks=$taskAPI.StartTime.ToUniversalTime().Ticks }
    $taskWeb = Start-Process -FilePath $taskNode -ArgumentList @('node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5173','--strictPort') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRuntime 'local-web.log') -RedirectStandardError (Join-Path $taskRuntime 'local-web-error.log')
    $taskEntries += @{ id=$taskWeb.Id; started_ticks=$taskWeb.StartTime.ToUniversalTime().Ticks }
    $taskEntries | ConvertTo-Json | Set-Content -LiteralPath $taskPidFile -Encoding utf8
    Write-Host '本地预览：http://127.0.0.1:5173'
    Write-Host '停止：.\start-local.ps1 -Stop'
} catch {
    foreach ($taskEntry in $taskEntries) { Stop-PreviewTree -TaskProcessId $taskEntry.id -ExpectedTicks ([long]$taskEntry.started_ticks) }
    throw
} finally {
    $env:DEV_MODE = $taskPreviousDev
    $env:AUTH_DATABASE_PATH = $taskPreviousDB
}
