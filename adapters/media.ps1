# media.ps1 —— 读本机「媒体会话」：谁在播、在播什么、播到第几秒（**只读**）
#
# 需求来源：用户要的第一条陪伴线是「陪我看电影/视频」。
# 需求是"知道播到哪、能不能控制"，不是"先做视觉"。Windows 的 SMTC 一次给两半：
#   看：标题 / 播放状态 / 播放位置 / 时长
#   手：暂停 / 播放 / 上一集 / 下一集（本脚本**只做看**，控制另开）
#
# ── 本脚本存在的真正理由：位置字段会**静默地**骗人 ────────────────────
#
# 实测（自己的无头浏览器 + 页面 currentTime 当真值，278 个样本）：
#
#   直接读 Position：平均误差 **9.05 秒**，最大 25.8 秒
#   锚点 + 经过时间：平均误差 0.575 秒
#   **本脚本用的办法：平均误差 0.066 秒，最大 0.075 秒**
#
# 为什么直接读会错：**Position 只在状态变化时刷新。** 两次变化之间它冻死不动，
# 而状态照样报 Playing —— 所以"播到第几分"会给出一个冻结的假数字，**且不报任何错**。
# 暂停那一刻它反而精确到小数点后 5 位（实测误差 1e-5 秒）。
#
# 正确做法：`LastUpdatedTime` 记着"这个位置值是**什么时候**取的"，
# 于是  真实位置 = Position + (现在 − LastUpdatedTime) × 播放速率
# 这个办法还顺带解决"中途接入"：锚点法做不到，因为中途接入时第一个锚点是陈旧的。
#
# ── 已知陷阱（都是实测，不是推测）────────────────────────────────────
#
#   * 会话计数：`$mgr.GetSessions()` 返回 COM 投影对象，**不是 PowerShell 数组**。
#     写 `$ss.Count` 会走进"成员枚举"，**不是元素个数**；只有 1 个会话时它恰好算对
#     （实测：2 个会话时报出「1 1」）。必须用 foreach 收集成真数组再数。
#   * 直播流的 EndTime 是 0 或负的近零 → 用 Position/EndTime 算进度会得到垃圾。
#     **直播和点播必须分开判**（本脚本用 `live` 字段标出来）。
#   * 浏览器（Edge/Chrome）**不主动推送**位置；原生应用（实测 QQMusic）每 3 秒准 +3.0。
#     所以同一个字段的可用性**是分应用的**。
#
# 用法：
#   media.ps1                 原样：把每个会话的原始字段全打出来（测新包时用这个）
#   media.ps1 -Now            结论：谁在播 / 在播什么 / 是播是停 / 播到第几秒
#   media.ps1 -Track -Seconds 30   跟踪 30 秒，只在状态或位置变化时打印
#
# ★ 控制模式（会改变世界，是唯一带写操作的模式）：
#   media.ps1 -Control pause|play|toggle -Match "<标题或程序名子串>"
#   media.ps1 -Control seek -Match "<子串>" -To <秒>
#   media.ps1 -Control next|prev -Match "<子串>"
#   为什么必须带 -Match：本机同时可能有多个会话（用户正在看的直播 + 音乐 + 测试源）。
#   不指定目标就是**猜**，猜错会去暂停用户正在看的东西。多于一匹配一律拒绝动手。
#   为什么调完要核实：实测五个写操作里有两个**返回 True 却什么都没做**。
#   本脚本不报"命令发出去了"，只报"状态真的变了没有"，没变就 exit 3。
#
# 退出码：0 = 读到了可信的值；2 = 通道不可用；3 = 位置不可信（不静默给数字）；
#   4 = 拒绝执行（目标不明确 / 停手）；5 = 这件事在这个目标上不适用；6 = 已停手，连读都不读

param(
  [switch]$Raw,
  [switch]$Now,
  [switch]$Track,
  [ValidateSet('pause','play','toggle','seek','next','prev')][string]$Control = '',
  [string]$Match = '',
  [double]$To = -1,
  [int]$VerifyMs = 900,
  [string]$Publish = '',
  [int]$Seconds = 20,
  [int]$IntervalMs = 500,
  [double]$StaleWarnSec = 60,
  # 记性保留多久。默认 **10 天**（用户定的：先写 30 太长，改 7 又偏紧，最后落 10）。
  # 原来的 30 天理由是"每周一集的番不要正好过期"，但那等于在家里攒一份一个月的
  # "你在这台电脑上看过什么"清单。**代价是隐私，不是容量**（多少天都只有几百 KB）。
  [int]$RememberDays = 10
)

$ErrorActionPreference = 'Stop'
# 严格模式是**闸门**，不是风格偏好：
# 未定义变量、访问不存在的属性，默认都会静默变成 $null，让判断悄悄通过。
# 实测踩过：核实条件里写了一个从未定义的 $beforeInfo，$null 比较恒为真，
# 于是"能力根本不存在"的命令被报成 DONE（假通过）。
Set-StrictMode -Version Latest

# --- 通道：PowerShell 直连 WinRT（无需 pip，本机实测开箱可用）---
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
} catch {
  Write-Output ('CHANNEL UNAVAILABLE ' + $_.Exception.Message)
  exit 2
}

function Await($op, $t) {
  $m = $asTaskGeneric.MakeGenericMethod($t)
  $nt = $m.Invoke($null, @($op))
  $nt.Wait(-1) | Out-Null
  $nt.Result
}

# 可靠的会话列表。**不要**对 GetSessions() 的返回值直接取 .Count——见文件头。
function Get-SessionList {
  $mgr = Await ($mgrType::RequestAsync()) $mgrType
  $list = @()
  foreach ($s in $mgr.GetSessions()) { $list += $s }
  return , $list
}

function Get-Info($session) {
  $title = ''; $artist = ''
  try {
    $p = Await ($session.TryGetMediaPropertiesAsync()) $propType
    $title = [string]$p.Title; $artist = [string]$p.Artist
  } catch { $title = '<props-unreadable>' }
  return [pscustomobject]@{ title = $title; artist = $artist }
}

# 位置推算。**这是本脚本的核心**：不是直接返回 Position，而是把它加回"距上次刷新的时间"。
function Get-Position($session) {
  $status = 'Unknown'; $rate = 1.0
  try {
    $pi = $session.GetPlaybackInfo()
    $status = [string]$pi.PlaybackStatus
    if ($pi.PlaybackRate -gt 0) { $rate = [double]$pi.PlaybackRate }
  } catch { }
  $tp = $null
  try { $tp = $session.GetTimelineProperties() } catch { }
  if ($null -eq $tp) {
    return [pscustomobject]@{ ok = $false; why = 'timeline-unreadable' }
  }
  $pos = $tp.Position.TotalSeconds
  $end = $tp.EndTime.TotalSeconds
  $start = $tp.StartTime.TotalSeconds
  $lag = $null
  try { $lag = ([DateTimeOffset]::UtcNow - $tp.LastUpdatedTime).TotalSeconds } catch { }
  if ($null -eq $lag) {
    # 拿不到刷新时刻就不能推算，宁可报错也不给一个冻结的数字
    return [pscustomobject]@{ ok = $false; why = 'last-updated-unreadable'; raw = $pos }
  }
  $elapsed = if ($status -eq 'Playing') { $lag * $rate } else { 0 }
  return [pscustomobject]@{
    ok     = $true
    status = $status
    raw    = $pos
    lag    = $lag
    rate   = $rate
    pos    = $pos + $elapsed      # 推算出来的真实位置
    end    = $end
    start  = $start
    live   = ($end - $start -le 0.5)                              # 直播：时长字段是空的
    stale  = ($status -eq 'Playing' -and $lag -gt $StaleWarnSec)  # 外推太久，要怀疑
  }
}

function Fmt([double]$sec) {
  if ($sec -lt 0) { return '-' }
  $t = [TimeSpan]::FromSeconds($sec)
  return ('{0:d2}:{1:d2}:{2:d2}' -f [int]$t.TotalHours, $t.Minutes, $t.Seconds)
}

# ---------------------------------------------------------------- 面板与叫停（senses 根目录下的 work/panel）
# ⑦「你能叫停它」的机械实现不是按钮好不好看，而是**每一条会改变世界的命令在这里退回去**。
$sensesRoot = Split-Path -Parent $PSScriptRoot
$panelDir   = Join-Path $sensesRoot 'work\panel'
$stopFlag   = Join-Path $panelDir 'stop.flag'

# ---------------------------------------------------------------- 记性（它记得看过什么）
# 「陪看」需要记性：遥控器不用记得你昨天看了什么，陪看的人需要。
# 只记**事件**，不记采样：同一个节目、状态没变、位置没跳超过 30 秒，就不写第二行 ——
# 否则一秒一行，记性会退化成噪声，回答"上次看到哪"时还得自己再筛一遍。
$memDir  = Join-Path $sensesRoot 'work\memory'
$utf8Mem = New-Object System.Text.UTF8Encoding($false)

function Get-MemFile([datetime]$d) { return (Join-Path $memDir ($d.ToString('yyyy-MM-dd') + '.jsonl')) }

function Read-MemFile([string]$f) {
  if (-not (Test-Path -LiteralPath $f)) { return @() }
  return @([IO.File]::ReadAllLines($f, $utf8Mem) | Where-Object { $_.Trim() -ne '' })
}

function Test-SameShow([string]$a, [string]$b) {
  # 「是不是同一个节目」——**这条规则只写在这里**。
  # 原来它在三个地方各写了一遍（写入去重 / 「刚才」/「近期」），于是漏改一处就出鬼：
  # 实测「刚才」和「近期」里，同一个视频显示成两种标题（一个带 `_哔哩哔哩_bilibili` 一个不带）。
  #
  # 判据：标题相同，或**互为前缀**。标题会"自己变完整"：同一个 B 站视频先报
  # 「…_哔哩哔哩_bilibili」，两秒后又报「…」。前缀关系这条判据不依赖任何网站的具体后缀写法。
  # 空标题必须在外面就被排除：空串是任何字符串的前缀，混进来会把之后所有东西都判成"同一个"。
  if ($a -eq '' -or $b -eq '') { return ($a -eq $b) }
  return (($a -eq $b) -or $a.StartsWith($b) -or $b.StartsWith($a))
}

function Add-Memory([string]$app, [string]$title, [string]$status, [double]$pos, [bool]$live) {
  # 停手 = **连记都不记**。一个停手之后还在继续记的记性，会让「停手」变成空话。
  if (Test-Path -LiteralPath $stopFlag) { return }
  $t = $title.Trim()
  # 空标题 = 噪声，不记。实测：Edge 关标签页时会报一条 status=Closed、标题空白的记录，
  # 于是"刚才"有可能显示成一个空的「」。这种东西没有任何记忆价值。
  if ($t -eq '') { return }
  try {
    if (-not (Test-Path $memDir)) { New-Item -ItemType Directory -Force -Path $memDir | Out-Null }
    $f = Get-MemFile (Get-Date)
    # 必须用 `@()` 包住：PowerShell 函数返回的是**流**，只有一条记录时会被拆成单个字符串，
    # 于是 `.Count` 在严格模式下当场炸（实测踩过；加 `@()` 之前 -Now 是 exit 1 而不是 0）。
    $lines = @(Read-MemFile $f)
    if ($lines.Count -gt 0) {
      $last = $null
      try { $last = ConvertFrom-Json $lines[$lines.Count - 1] } catch { $last = $null }
      if ($null -ne $last) {
        $titleSame = Test-SameShow (([string]$last.title).Trim()) $t
        $same = ((([string]$last.app) -eq $app) -and $titleSame -and (([string]$last.status) -eq $status))
        $near = ([math]::Abs(([double]$last.pos) - $pos) -lt 30)
        # 还要"够新"。只按变化去重会漏掉最要紧的那个数：连看一小时没跳进度，
        # 于是整小时只在开头留了一笔，"上次看到哪"答的是**开头**，不是看到哪了。
        # 所以再补一条：同一状态最多每 5 分钟留一个锚点。
        $fresh = $false
        try { $fresh = (((Get-Date) - [datetime]::ParseExact([string]$last.at, 'yyyy-MM-dd\THH:mm:ss', $null)).TotalMinutes -lt 5) } catch { $fresh = $false }
        if ($same -and $near -and $fresh) { return }
      }
    }
    $rec = [pscustomobject]@{
      at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'); app = $app; title = $t
      status = $status; pos = [math]::Round($pos, 1); live = $live
    }
    [IO.File]::AppendAllText($f, (($rec | ConvertTo-Json -Compress) + "`n"), $utf8Mem)
  } catch { }
}

function Remove-OldMemory {
  try {
    if (-not (Test-Path $memDir)) { return }
    $cut = (Get-Date).Date.AddDays(-$RememberDays)
    Get-ChildItem $memDir -File -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object {
      $d = [datetime]::MinValue
      try { $d = [datetime]::ParseExact($_.BaseName, 'yyyy-MM-dd', $null) } catch { $d = [datetime]::MinValue }
      if ($d -ne [datetime]::MinValue -and $d -lt $cut) { Remove-Item -LiteralPath $_.FullName -Force }
    }
  } catch { }
}

function Get-RecentMemory([string]$notApp, [string]$notTitle) {
  # 从今天往回找最近一条**和现在不同的**记录 —— 那才是"刚才在看的东西"。
  # 只回看 3 天：更早的不叫"刚才"。
  for ($k = 0; $k -lt 3; $k++) {
    $lines = @(Read-MemFile (Get-MemFile ((Get-Date).Date.AddDays(-$k))))
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      $o = $null
      try { $o = ConvertFrom-Json $lines[$i] } catch { $o = $null }
      if ($null -eq $o) { continue }
      $isSame = $false
      try { $isSame = ((([string]$o.app) -eq $notApp) -and (Test-SameShow (([string]$o.title).Trim()) $notTitle)) } catch { $isSame = $false }
      if (-not $isSame) { return $o }
    }
  }
  return $null
}

function Test-MemoryExist {
  # 「有记录但都和现在一样」和「压根没有记录」是两回事，提示语不能混为一谈。
  for ($k = 0; $k -lt 3; $k++) {
    if (@(Read-MemFile (Get-MemFile ((Get-Date).Date.AddDays(-$k)))).Count -gt 0) { return $true }
  }
  return $false
}

function Fmt-Ago([string]$at) {
  # 「00:23:58」是钟点，「12 分钟前」才是**多久以前**。用户看的是后者。
  $d = [datetime]::MinValue
  try { $d = [datetime]::ParseExact($at, 'yyyy-MM-dd\THH:mm:ss', $null) } catch { return '' }
  $m = ((Get-Date) - $d).TotalMinutes
  if ($m -lt 1) { return '刚刚' }
  if ($m -lt 60) { return ([string][int][math]::Round($m) + ' 分钟前') }
  if ($m -lt 1440) { return ([string][math]::Round($m / 60, 1) + ' 小时前') }
  return ([string][math]::Round($m / 1440, 0) + ' 天前')
}

function Get-RecentList([int]$max) {
  # 「最近几次都看了啥」—— 用户最自然会问的一句，而只做「刚才」那一格答不了。
  # 同一个节目只留**最后一次**（不然连看两小时会刷屏），从新到旧。
  $out = @()
  $seen = @()
  for ($k = 0; $k -lt 3; $k++) {
    $lines = @(Read-MemFile (Get-MemFile ((Get-Date).Date.AddDays(-$k))))
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      $o = $null
      try { $o = ConvertFrom-Json $lines[$i] } catch { $o = $null }
      if ($null -eq $o) { continue }
      $t = ''
      try { $t = ([string]$o.title).Trim() } catch { $t = '' }
      if ($t -eq '') { continue }
      # 标题"自己变完整"的那两条要合成一条 —— 用和写入侧**同一个**判据。
      $dup = $false
      foreach ($s in $seen) { if (Test-SameShow $s $t) { $dup = $true; break } }
      if ($dup) { continue }
      $seen += $t
      $out += $o
      if ($out.Count -ge $max) { return $out }
    }
  }
  return $out
}

function Write-ActionLog([string]$result, [string]$detail) {
  # 供面板显示「它刚才做了什么」。写不进去也不能让命令失败。
  try {
    if (-not (Test-Path $panelDir)) { New-Item -ItemType Directory -Force -Path $panelDir | Out-Null }
    $rec = [pscustomobject]@{
      at = (Get-Date).ToString('HH:mm:ss'); cmd = $Control; match = $Match
      result = $result; detail = $detail
    }
    # **不要用 Add-Content -Encoding UTF8**：PowerShell 5.1 建新文件时会写入 BOM，
    # 首行带 BOM 会让面板的 JSON.parse 失败，那条动作就在面板里"看不见"（实测踩过）。
    $line = ($rec | ConvertTo-Json -Compress) + [Environment]::NewLine
    [IO.File]::AppendAllText((Join-Path $panelDir 'actions.jsonl'), $line,
                             (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}
# ---------------------------------------------------------------- 模式闸门
# 多模式的脚本必须显式指定模式；不指定就**非零退出**。
# 为什么：实测踩过 —— 调用方一个参数都没传（变量名撞上 PowerShell 自动变量 $args），
# 脚本静默退回默认的"原样模式"并报 exit=0，看起来完全正常。
# **"参数没收到就按默认跑"是最难发现的一类静默失败。**
$modeCount = 0
foreach ($m in @($Raw, $Now, $Track)) { if ($m) { $modeCount++ } }
if ($Publish -ne '') { $modeCount++ }
if ($Control -ne '') { $modeCount++ }
if ($modeCount -eq 0) {
  Write-Output 'USAGE 必须显式指定模式：-Raw | -Now | -Track | -Control <pause|play|toggle|seek|next|prev>'
  exit 64
}
if ($modeCount -gt 1) {
  Write-Output 'USAGE 一次只能用一种模式'
  exit 64
}
# ---------------------------------------------------------------- 发布模式（只读，给面板看）
# 面板不该自己去调 PowerShell（每次进程启动要几百毫秒）；这里按节奏把状态写成文件，
# 面板只读文件。发布者只做只读查询，绝不改变任何东西。
if ($Publish -ne '') {
  New-Item -ItemType Directory -Force -Path $Publish | Out-Null
  $statePath = Join-Path $Publish 'state.json'
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    # 「停手」= **不看，也不动**。
    # 原来只停了"动"，继续每秒读用户的媒体状态 —— 对用户来说那还是"它还在盯着我"，
    # 按下去看不出任何变化，于是没法验证（用户原话：叫停后它依旧知道我在看什么）。
    # 所以停手期间**连读都不读**，直接把"什么都没有"发布出去。
    if (Test-Path -LiteralPath $stopFlag) {
      $off = [pscustomobject]@{
        ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        at = (Get-Date).ToString('HH:mm:ss'); stopped = $true
        anyPlaying = $null; playing = 0; paused = 0; other = 0; sessions = @()
        note = '已停手：既不动，也不看'
      }
      try { [IO.File]::WriteAllText($statePath, ($off | ConvertTo-Json -Depth 5 -Compress), $utf8) } catch { }
      Start-Sleep -Milliseconds $IntervalMs
      continue
    }
    $list = Get-SessionList
    $rows = @()
    $nPlaying = 0; $nPaused = 0; $nOther = 0
    foreach ($s in $list) {
      $i = Get-Info $s
      $pp = Get-Position $s
      $app = [string]$s.SourceAppUserModelId
      $st = 'Unknown'; $pos = 0.0; $live = $false
      if ($pp.ok) { $st = $pp.status; $pos = [math]::Round($pp.pos, 1); $live = $pp.live }
      if ($st -eq 'Playing') { $nPlaying++ } elseif ($st -eq 'Paused') { $nPaused++ } else { $nOther++ }
      $rows += [pscustomobject]@{ app = $app; title = $i.title; status = $st; pos = $pos; live = $live }
    }
    # 面板的发布者天然就是个采样器：让它顺手记一笔，记性才不用等 agent 来问才有内容。
    foreach ($row in $rows) { Add-Memory $row.app $row.title $row.status ([double]$row.pos) ([bool]$row.live) }
    $doc = [pscustomobject]@{
      # `ts` 是机器可读的时间戳（Unix 毫秒）。`at` 只是给人看的 HH:mm:ss，
      # 面板没法拿它判断"这数据多旧了"（还会跨零点出错）。
      # 实测踩过：发布者按 -Seconds 跑满就退出，而面板**继续静静显示旧数字**、
      # 一点提示都没有 —— 那等于 ⑥「你看得见它在做什么」自己撒谎。
      ts         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      at         = (Get-Date).ToString('HH:mm:ss')
      anyPlaying = ($nPlaying -gt 0)
      playing    = $nPlaying
      paused     = $nPaused
      other      = $nOther
      stopped    = (Test-Path -LiteralPath $stopFlag)
      sessions   = $rows
    }
    try { [IO.File]::WriteAllText($statePath, ($doc | ConvertTo-Json -Depth 5 -Compress), $utf8) } catch { }
    Start-Sleep -Milliseconds $IntervalMs
  }
  exit 0
}
# ---------------------------------------------------------------- 控制模式（**写操作**）
# 与其它模式的根本区别：这是唯一会改变世界的模式。所以它有三条别的模式没有的规矩：
#   1) 必须 -Match 指定目标；多于一匹配就拒绝（绝不猜是哪一个）
#   2) 调完必须复读状态核实 —— Try*Async 返回 True 只代表"请求被接受"
#   3) 核实不过就 exit 3，不静默通过
if ($Control -ne '') {
  # 叫停闸门放在**最前面**：只要标志在，一律拒绝，**连目标都不查**（fail closed）。
  if (Test-Path -LiteralPath $stopFlag) {
    Write-ActionLog 'REFUSED-STOPPED' '叫停标志在'
    Write-Output ('REFUSED-STOPPED 叫停标志在（' + $stopFlag + '）—— 不执行任何写操作')
    exit 6
  }
  # 目标从哪来：优先 -Match；没给就看面板上有没有「就是它」指过一个。
  # **两样都没有就拒绝。** 同时开着好几个的时候，"猜一个最像的"是这里最危险的动作。
  if ([string]::IsNullOrWhiteSpace($Match)) {
    $targetFile = Join-Path $panelDir 'target.json'
    if (Test-Path -LiteralPath $targetFile) {
      try {
        $tj = Get-Content -LiteralPath $targetFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$tj.title)) { $Match = [string]$tj.title }
        elseif (-not [string]::IsNullOrWhiteSpace([string]$tj.app)) { $Match = [string]$tj.app }
      } catch { }
    }
  }
  if ([string]::IsNullOrWhiteSpace($Match)) {
    Write-ActionLog 'REFUSED-NOTARGET' '没指定目标，面板上也没指'
    Write-Output 'REFUSED 没指定目标：用 -Match，或先在面板上「就是它」指一个（绝不猜）'
    exit 4
  }
  function Find-Target {
    $out = @()
    foreach ($s in (Get-SessionList)) {
      $i = Get-Info $s
      $app = [string]$s.SourceAppUserModelId
      if (($i.title -like ('*' + $Match + '*')) -or ($app -like ('*' + $Match + '*'))) {
        $out += [pscustomobject]@{ s = $s; title = $i.title; app = $app }
      }
    }
    return , $out
  }
  $hits = Find-Target
  if ($hits.Count -eq 0) {
    # 拒绝也要留痕：面板的"它刚做了什么"必须包含**没做成的事**，
    # 否则用户按了「试一下」而当时没停手，那一下在面板上就看不见（实测发现的洞）。
    Write-ActionLog 'NOMATCH' ('没匹配到「' + $Match + '」')
    Write-Output ('NOMATCH 没有匹配「' + $Match + '」的会话'); exit 2
  }
  if ($hits.Count -gt 1) {
    Write-ActionLog 'REFUSED-AMBIGUOUS' ($hits.Count.ToString() + ' 个都匹配')
    Write-Output ('REFUSED 匹配到 ' + $hits.Count + ' 个会话，拒绝动手：')
    foreach ($h in $hits) { Write-Output ('    ' + $h.app + '  「' + $h.title + '」') }
    exit 4
  }
  $tag = $hits[0].app + ' 「' + $hits[0].title + '」'
  $before = Get-Position $hits[0].s
  $beforeInfo = Get-Info $hits[0].s
  if (-not $before.ok) { Write-Output ('UNKNOWN 行动前读不到状态: ' + $before.why); exit 3 }

  $accepted = $false
  switch ($Control) {
    'pause'  { $accepted = Await ($hits[0].s.TryPauseAsync()) ([bool]) }
    'play'   { $accepted = Await ($hits[0].s.TryPlayAsync()) ([bool]) }
    'toggle' { $accepted = Await ($hits[0].s.TryTogglePlayPauseAsync()) ([bool]) }
    'next'   { $accepted = Await ($hits[0].s.TrySkipNextAsync()) ([bool]) }
    'prev'   { $accepted = Await ($hits[0].s.TrySkipPreviousAsync()) ([bool]) }
    'seek'   {
      if ($To -lt 0) { Write-Output 'REFUSED seek 需要 -To <秒>'; exit 4 }
      $accepted = Await ($hits[0].s.TryChangePlaybackPositionAsync([long]($To * 10000000))) ([bool])
    }
  }

  # ── 核实：**每次都必须重新取会话列表** ──────────────────────────────────
  # 两个实测踩过的坑，都让人把**成功**的操作判成失败（假失败）：
  #
  #  ① 等得不够：QQ音乐 Paused→Playing 要 1 秒以上才生效。→ 轮询到确认变化为止。
  #  ② **会话对象是快照**：拿住一个对象、从外部暂停它，它仍然报 Playing；
  #     重新 GetSessions() 才看到 Paused（两个对象 ReferenceEquals=False）。
  #     所以"拿住对象反复读"这种轮询**读的是同一份陈旧数据**，等多久都没用。
  #
  # 假失败比假成功更阴：它会让人去**重试一个已经成功的动作**——
  # 对 play 无所谓，对 next/seek 就是灾难（多跳一曲、多拖一次）。
  #
  # 身份怎么认（对象每次都是新的，不能按引用比）：
  #   AppId 下只有一个会话 → 就是它；有多个 → 用标题区分
  #   （next/prev 的标题**本来就会变**，所以按"和之前不同"找）。认不出就 UNKNOWN，**绝不猜**。
  $appId = [string]$hits[0].s.SourceAppUserModelId
  $titleB = $beforeInfo.title
  $titleMayChange = (($Control -eq 'next') -or ($Control -eq 'prev'))

  $verified = $false; $what = ''; $after = $null; $afterInfo = $null
  $unreadable = $true
  foreach ($attempt in 1..5) {
    Start-Sleep -Milliseconds $VerifyMs
    $fresh = Get-SessionList
    $sameApp = @()
    foreach ($cand in $fresh) { if ([string]$cand.SourceAppUserModelId -eq $appId) { $sameApp += $cand } }
    $pick = $null
    if ($sameApp.Count -eq 1) {
      $pick = $sameApp[0]
    } elseif ($sameApp.Count -gt 1) {
      $matched = @()
      foreach ($cand in $sameApp) {
        $ci = Get-Info $cand
        if ($titleMayChange) { if ($ci.title -ne $titleB) { $matched += $cand } }
        else { if ($ci.title -eq $titleB) { $matched += $cand } }
      }
      if ($matched.Count -eq 1) { $pick = $matched[0] }
    }
    if ($null -eq $pick) { $unreadable = $true; continue }
    $after = Get-Position $pick
    if ($null -eq $after -or -not $after.ok) { $unreadable = $true; continue }
    $afterInfo = Get-Info $pick
    $unreadable = $false

    # 核实：拿"世界真的变了吗"当判据，不拿返回值当判据
    $verified = $false; $what = ''
    switch ($Control) {
      'pause'  { $verified = ($after.status -eq 'Paused');      $what = ($before.status + ' -> ' + $after.status) }
      'play'   { $verified = ($after.status -eq 'Playing');     $what = ($before.status + ' -> ' + $after.status) }
      'toggle' { $verified = ($after.status -ne $before.status); $what = ($before.status + ' -> ' + $after.status) }
      'seek'   { $verified = ([math]::Abs($after.pos - $To) -le 3); $what = ('位置 ' + [math]::Round($after.pos, 2) + '，目标 ' + $To) }
      'next'   { $verified = ($afterInfo.title -ne $beforeInfo.title) -or ([math]::Abs($after.pos - $before.pos) -gt 5)
                 $what = ('「' + $beforeInfo.title + '」->「' + $afterInfo.title + '」') }
      'prev'   { $verified = ($afterInfo.title -ne $beforeInfo.title) -or ([math]::Abs($after.pos - $before.pos) -gt 5)
                 $what = ('「' + $beforeInfo.title + '」->「' + $afterInfo.title + '」') }
    }
    if ($verified) { break }
  }
  if ($unreadable -or $null -eq $after -or $null -eq $afterInfo) {
    Write-Output ('UNKNOWN 行动后认不出目标会话（可能真的没了，或同 AppId 多会话认不出）  命令=' + $Control)
    exit 3
  }

  if ($accepted -and $verified) {
    Write-ActionLog 'DONE' $what
    Write-Output ('DONE  ' + $Control + '  ' + $tag + '   ' + $what)
    exit 0
  }
  # 返回 True 但世界没变 —— **先问"这个能力到底存不存在"，再决定怎么定性**。
  # 不这么分，单首素材上的「下一集」会被报成静默失败（实测踩过，是假警报）。
  #
  # ★ 第二个实测：**这个包的"能力位"会说谎。** 直播上 Controls 报
  #   IsPlaybackPositionEnabled=True，但 seek 跳不动（位置还在继续涨）。
  #   直播没有可跳转的区间 —— 所以 seek 的可用性**不能只看那个位**，还要看是不是直播。
  $capable = $null
  $capWhy = ''
  try {
    $c = $hits[0].s.GetPlaybackInfo().Controls
    switch ($Control) {
      'pause'  { $capable = ($c.IsPauseEnabled -or $c.IsPlayPauseToggleEnabled) }
      'play'   { $capable = ($c.IsPlayEnabled -or $c.IsPlayPauseToggleEnabled) }
      'toggle' { $capable = $c.IsPlayPauseToggleEnabled }
      'next'   { $capable = $c.IsNextEnabled }
      'prev'   { $capable = $c.IsPreviousEnabled }
      'seek'   {
        if ($after.live) { $capable = $false; $capWhy = '（直播没有可跳转的区间，虽然 Controls 报可用）' }
        else { $capable = $c.IsPlaybackPositionEnabled }
      }
    }
  } catch { }
  if ($accepted -and -not $verified) {
    if ($capable -eq $false) {
      Write-ActionLog 'NOT-APPLICABLE' $what
      Write-Output ('NOT-APPLICABLE  ' + $Control + '  ' + $tag + '  环境不支持这个动作（Controls 报不可用）' + $capWhy + '  ' + $what)
      exit 5
    }
    Write-ActionLog 'SILENT-FAIL' $what
    Write-Output ('* SILENT-FAIL  ' + $Control + '  ' + $tag + '  返回 True 但世界没变，且环境说这个动作可用  ' + $what)
    exit 3
  }
  Write-Output ('FAILED  ' + $Control + '  ' + $tag + '   调用本身失败（返回 ' + $accepted + '）')
  exit 3
}
# ---------------------------------------------------------------- 原样模式
if ($Raw) {
  $list = Get-SessionList
  Write-Output ("SESSIONS " + $list.Count)
  foreach ($s in $list) {
    $i = Get-Info $s
    $pp = Get-Position $s
    Write-Output ("  app      = " + [string]$s.SourceAppUserModelId)
    Write-Output ("  title    = " + $i.title)
    if ($pp.ok) {
      Write-Output ("  status   = " + $pp.status + "   rate=" + $pp.rate)
      Write-Output ("  pos      = " + $pp.raw + "   (原始值，未推算)")
      Write-Output ("  lag      = " + [math]::Round($pp.lag, 2) + " 秒   (这个值有多旧)")
      Write-Output ("  end      = " + $pp.end + "   live=" + $pp.live)
    } else {
      Write-Output ("  position = 读不出来 (" + $pp.why + ")")
    }
  }
  exit 0
}

# ---------------------------------------------------------------- 结论模式
if ($Now) {
  # 闸门：停手 = **不看，也不动**。原来这条读路径不查标志，于是面板上写着「它已经停手 —— 不看」，
  # 而 agent 照样能把它正在播什么读出来 —— 那是面板在替它撒谎（实测发现）。
  if (Test-Path -LiteralPath $stopFlag) {
    Write-Output ('REFUSED-STOPPED 已停手：不读，也不记（' + $stopFlag + '）—— 要读请先在面板按「放开」')
    exit 6
  }
  Remove-OldMemory
  $list = Get-SessionList
  # 闸门：**直接把「有没有东西在播」这个结论说出来**，不要让调用方从明细里自己推断。
  # 判据是「存在状态为 Playing 的会话」，**不是**「会话数 > 0」——
  # 实测：把播放暂停之后会话**仍然在**（status=Paused），
  # 用会话数判断会得出"有在播"这个错误答案。
  $nPlaying = 0; $nPaused = 0; $nOther = 0
  foreach ($s in $list) {
    $st = 'Unknown'
    try { $st = [string]$s.GetPlaybackInfo().PlaybackStatus } catch { }
    if ($st -eq 'Playing') { $nPlaying++ } elseif ($st -eq 'Paused') { $nPaused++ } else { $nOther++ }
  }
  $nowApp = ''; $nowTitle = ''
  if ($list.Count -eq 0) {
    Write-Output 'ANY-PLAYING no   (会话数 0：通道可用，但没有任何媒体会话)'
  } else {
    Write-Output ('ANY-PLAYING ' + $(if ($nPlaying -gt 0) { 'yes' } else { 'no' }) +
                  '   (playing=' + $nPlaying + ' paused=' + $nPaused + ' other=' + $nOther + ')')
  }
  $bad = 0
  foreach ($s in $list) {
    $i = Get-Info $s
    $pp = Get-Position $s
    $app = [string]$s.SourceAppUserModelId
    if (-not $pp.ok) {
      Write-Output ("UNKNOWN  " + $app + "  「" + $i.title + "」  位置读不出来: " + $pp.why)
      $bad++
      continue
    }
    $prog = if ($pp.live) { '直播' } else { (Fmt $pp.pos) + ' / ' + (Fmt $pp.end) }
    Write-Output ("OK  " + $app + "  " + $pp.status + "  " + $prog + "  「" + $i.title + "」")
    if ($pp.stale) {
      # 闸门：**不许把一个不可能为真的数打印出来**。直播流的 LastUpdatedTime 往往是"没设过"，
      # 于是 lag 算出来是 13435517033 秒 —— 426 年，而它**真的印给用户看了**（实测）。
      # 与其印一个荒唐的数字，不如直说这个值不可信。
      $lagTxt = if (($pp.lag -ge 0) -and ($pp.lag -lt 86400)) {
        '已 ' + [math]::Round($pp.lag, 0) + ' 秒没刷新'
      } else {
        '刷新时间不可信（LastUpdatedTime 像没设过）'
      }
      if ($pp.live) {
        # 直播流本来就没有"播到第几分"可言（EndTime 是空的），它不推送位置不算缺陷
        Write-Output ("    (直播，位置属性无意义；" + $lagTxt + ")")
      } else {
        Write-Output ("    ! 位置" + $lagTxt + "，推算靠外推，只能当粗略值")
        $bad++
      }
    }
    Add-Memory $app $i.title $pp.status $pp.pos $pp.live
    if ($nowApp -eq '') { $nowApp = $app; $nowTitle = $i.title }
  }
  # 「刚才」：和现在不同的最近一条。**现在什么都没在播时，这条最有用** ——
  # 那正是"你去吃饭回来问它我们刚才看到哪"的场景。
  $r = Get-RecentMemory $nowApp $nowTitle
  if ($null -ne $r) {
    $rt = [string]$r.at
    if ($rt.Length -ge 19) { $rt = $rt.Substring(11) }
    $rp = ''
    if (-not [bool]$r.live) { $rp = '  ' + (Fmt ([double]$r.pos)) }
    Write-Output ('刚才 ' + $rt + '（' + (Fmt-Ago ([string]$r.at)) + '）  ' + [string]$r.app + '  ' +
                  [string]$r.status + $rp + '  「' + [string]$r.title + '」')
  } else {
    if (Test-MemoryExist) {
      Write-Output '刚才 （记得的只有现在这个 —— 没有别的东西）'
    } else {
      Write-Output '刚才 （还没有任何记录 —— 这是它第一次看）'
    }
  }
  # 「近期」：回答"最近几次都看了啥"。只有一个节目时不说 —— 那和上面那行重复。
  $recent = @(Get-RecentList 6)
  if ($recent.Count -gt 1) {
    Write-Output ('近期 ' + $recent.Count + ' 个节目（新的在前；同一个只留最后一次）：')
    foreach ($o in $recent) {
      $oa = [string]$o.at
      $hm = if ($oa.Length -ge 19) { $oa.Substring(11, 5) } else { $oa }
      $op = ''
      try { if (-not [bool]$o.live) { $op = '  ' + (Fmt ([double]$o.pos)) } } catch { $op = '' }
      Write-Output ('  ' + $hm + '  ' + (Fmt-Ago $oa) + '  ' + [string]$o.app + '  ' +
                    [string]$o.status + $op + '  「' + [string]$o.title + '」')
    }
  }
  if ($bad -gt 0) { exit 3 }
  exit 0
}

# ---------------------------------------------------------------- 跟踪模式
if ($Track) {
  Write-Output ("TRACK 每 " + $IntervalMs + " ms 一次，共 " + $Seconds + " 秒；只在变化时打印")
  $deadline = (Get-Date).AddSeconds($Seconds)
  # 每个会话各自记住上一次的键。**不能用一个变量**：多个会话共用时，
  # 下一轮拿会话 1 的键去比会话 3 的键，永远不相等，于是每轮都误报"变了"（实测踩过）。
  $prev = @{}
  $lastBeat = Get-Date
  while ((Get-Date) -lt $deadline) {
    $list = Get-SessionList
    foreach ($s in $list) {
      $i = Get-Info $s
      $pp = Get-Position $s
      $app = [string]$s.SourceAppUserModelId
      if (-not $pp.ok) { continue }
      $id = $app + '|' + $i.title
      # 变化键只含"原始位置"：它是锚点，变了才说明真发生了跳变。
      # 推算值本来就该随墙上时钟前进，拿它当键会每轮都"变"。
      $key = $pp.status + '|' + [math]::Round($pp.raw, 3)
      if ((-not $prev.ContainsKey($id)) -or ($prev[$id] -ne $key)) {
        $prog = if ($pp.live) { '直播' } else { (Fmt $pp.pos) + '/' + (Fmt $pp.end) }
        Write-Output ("  " + (Get-Date).ToString('HH:mm:ss.fff') + "  CHG  " + $app +
                      "  " + $pp.status + "  " + $prog +
                      "  raw=" + [math]::Round($pp.raw, 2) + "  lag=" + [math]::Round($pp.lag, 1) + "s")
        $prev[$id] = $key
        $lastBeat = Get-Date
      }
    }
    # 心跳：5 秒无变化就打一条，免得看起来像卡死了
    if (((Get-Date) - $lastBeat).TotalSeconds -ge 5) {
      Write-Output ("  " + (Get-Date).ToString('HH:mm:ss.fff') + "       ... 无变化（跟踪中）")
      $lastBeat = Get-Date
    }
    Start-Sleep -Milliseconds $IntervalMs
  }
  Write-Output 'TRACK 结束'
  exit 0
}
