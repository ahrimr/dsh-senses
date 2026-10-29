# bili-browser.ps1 —— 管那个**后台（headless）**的受控 Edge：Start / Stop / Status。
#
# 为什么单独一个进程：subtitle.mjs 取字幕要靠它（B站 不认脚本裸调的 cookie，只认浏览器发起的请求）。
# 而 senses 里的后台进程一律**不常驻**（面板 panel.mjs、发布者 media.ps1 也是这个规矩），
# 用 start/stop 自己掌握，要打游戏就停掉，把那两三百 MB 还回来。
#
# ── 三条必须记住的 ──────────────────────────────────────────────────────────
# 1. 用的是**专用 profile**（playground\bili-headless），不碰日常浏览器。
# 2. 登录态在 profile 里；换了它就要重新扫码登录一次。
# 3. **复制 profile 必须在 Edge 关掉之后做** —— 开着复制会丢 SESSDATA（cookie 库的 WAL 没落盘），
#    表现是"cookie 还在但 SESSDATA/bili_jct/DedeUserID 没了"，登录态静默失效。踩过。
#
# ── 用法 ────────────────────────────────────────────────────────────────────
#   powershell -File senses\bili-browser.ps1 -Action Status
#   powershell -File senses\bili-browser.ps1 -Action Start
#   powershell -File senses\bili-browser.ps1 -Action Stop
#
# 退出码：0 = 目标状态已达成；1 = 没达成（起不来 / 停不掉 / profile 缺失）

[CmdletBinding()]
param(
  [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Status',
  [int]$Port = 9224,
  [int]$WaitSeconds = 15
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$senses = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $senses 'playground\bili-headless'

# UA 伪装：不让 B站 从 UA 里看到 HeadlessChrome
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0'

function Find-Edge {
  foreach ($p in 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
                 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return ''
}

function Test-Port {
  try {
    $null = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/json/version') -UseBasicParsing -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

# 只认「命令行里带这个端口」的 msedge —— **绝不按进程名一刀切**，那会杀掉用户的日常浏览器。
# 先取全表再筛：`-Filter "Name='msedge.exe'"` 在 cmd 层层转义里会被吃掉等号，踩过。
function Get-OurEdge {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -ne $null -and $_.CommandLine -match ('remote-debugging-port=' + $Port) })
}

switch ($Action) {

  'Status' {
    $up = Test-Port
    $procs = @(Get-OurEdge)
    Write-Output ('port  ' + $Port + '  ' + $(if ($up) { 'UP' } else { 'DOWN' }))
    Write-Output ('procs ' + $procs.Count + ' 个 msedge（命令行带该端口）')
    if ($up) {
      try {
        $v = (Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/json/version') -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
        Write-Output ('browser ' + $v.Browser)
      } catch { Write-Output 'browser 读不到' }
    }
    if ($up) { exit 0 } else { exit 1 }
  }

  'Stop' {
    $procs = @(Get-OurEdge)
    if ($procs.Count -eq 0) {
      Write-Output ('没有在跑（端口 ' + $Port + '）')
      if (Test-Port) { Write-Output '警告：端口还在，但有进程没带该端口 —— 不猜，交给人看'; exit 1 }
      exit 0
    }
    foreach ($p in $procs) {
      Write-Output ('结束 PID ' + $p.ProcessId)
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    # 不看返回值，看**实际状态**：端口真的要没了才算停住
    for ($i = 0; $i -lt ($WaitSeconds * 2); $i++) {
      if (-not (Test-Port)) { Write-Output '已停止'; exit 0 }
      Start-Sleep -Milliseconds 500
    }
    Write-Output ('警告：等了 ' + $WaitSeconds + ' 秒端口还在')
    exit 1
  }

  'Start' {
    if (-not (Test-Path -LiteralPath $profileDir)) {
      Write-Output ('没有 profile：' + $profileDir)
      Write-Output '要先用前台 Edge 扫码登录一次，再**关掉它**、把 bili-profile 复制成 bili-headless。'
      exit 1
    }
    if (Test-Port) {
      Write-Output ('已经在跑（端口 ' + $Port + '），不重复启动')
      exit 0
    }
    $edge = Find-Edge
    if ($edge -eq '') { Write-Output '找不到 msedge.exe'; exit 1 }

    $args = @(
      '--headless=new'
      ('--user-data-dir=' + $profileDir)
      ('--remote-debugging-port=' + $Port)
      '--no-first-run'
      '--no-default-browser-check'
      '--disable-gpu'
      ('--user-agent=' + $ua)
      'https://www.bilibili.com/'
    )
    # 整条当一个字符串传，路径带空格才不会在空格处断开（这个坑项目里踩过：Edge 会拿到 --user-data-dir=D:\deepseek）
    $q = [char]34
    $argLine = ($args | ForEach-Object { if ($_ -match '\s') { $q + $_ + $q } else { $_ } }) -join ' '
    Start-Process -FilePath $edge -ArgumentList $argLine | Out-Null

    for ($i = 0; $i -lt ($WaitSeconds * 2); $i++) {
      if (Test-Port) { Write-Output ('就绪（端口 ' + $Port + '）'); exit 0 }
      Start-Sleep -Milliseconds 500
    }
    Write-Output ('超时：' + $WaitSeconds + ' 秒内没起来')
    exit 1
  }
}
