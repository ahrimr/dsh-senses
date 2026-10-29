#!/usr/bin/env node
// watch.mjs —— 一次「陪看」调用：**按需起后台浏览器 → 读字幕 → 用完关掉**。
//
// 设计要点（都是踩出来或被指出来的）：
//
// 1. **只在被调用时运行。** 冷启动到可求值实测 0.96 秒，关闭 2.74 秒，热调用 0.42 秒。
//    所以"现起现停"成立，不需要常驻进程，也不占那两三百 MB。
// 2. **只有本次是自己起的才关。** 如果浏览器本来就是开着的（用户在连续测），不动它。
// 3. `policy=current_prefix` 是**陪看**：只给 t 之前的内容，而且要**去掉跨过 t 的那一条**
//    （一条字幕的文字和它内部时间不是线性对应，整条给出去就泄露了后半句）。
// 4. 默认只回看 180 秒。**不能把整段 [0,t] 全塞给模型** —— t 到一小时的时候那就是一小时的字幕，
//    等于把上下文成本原样复制一遍。
// 5. 多分P 不给 cid → 拒绝，不猜。

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fetchWindow, cdpEval } from './subtitle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SENSES = dirname(HERE)
const BROWSER_PS = join(SENSES, 'bili-browser.ps1')
const PORT = Number(process.env.BILI_CDP_PORT ?? 9224)

/** `current_prefix` 默认回看多少秒。太长会把上下文撑爆，太短接不上话。 */
const DEFAULT_BACK = 180

/**
 * 等到「CDP 里出现一个 bilibili.com 页面」为止。
 *
 * 为什么光等端口不够：实测 CDP 端口 0.73s 就绪，而 bilibili 页面 0.87s 才出现。
 * 中间那一百多毫秒里求值会报「CDP 里没有 bilibili.com 页面」—— 一个纯竞态，
 * 表现却像是"浏览器起不来"。所以这里必须等**页面**，不能只等端口。
 */
async function waitForBiliPage(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
      if (Array.isArray(list) && list.some((t) => t.type === 'page' && String(t.url ?? '').includes('bilibili.com'))) return true
    } catch { /* 端口还没活，继续等 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function cdpUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

/** 跑 bili-browser.ps1 的一个动作，返回 `{ code, out }`。 */
function browserAction(action) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', BROWSER_PS, '-Action', action,
  ], { encoding: 'utf8', timeout: 60000 })
  return { code: r.status === null ? -1 : r.status, out: String(r.stdout ?? '').trim() }
}

/**
 * 归一化标题，**只用于匹配**（不用于显示）。
 *
 * 实测踩到的两种对不上：
 *   1. 媒体会话给标题加后缀：`…_哔哩哔哩_bilibili`
 *   2. 标题本身带装饰：`【极客湾】荣耀Robot Phone上手体验…`、`…（上）`
 * 精确匹配只要有一处装饰就打不中，于是白白重试。这里把装饰性字符统一剥掉。
 *
 * @param s - 原始标题
 * @returns 只含文字与数字的归一化串
 */
export function normalizeTitle(s) {  return String(s)
    .replace(/\s*[-_|]\s*哔哩哔哩(\s*_\s*bilibili)?\s*$/iu, '')   // 媒体会话后缀
    .replace(/【[^】]*】/gu, '')                                   // 【频道名】
    .replace(/\[[^\]]*\]/gu, '')
    .replace(/[（(][^）)]*[）)]\s*$/u, '')                         // 结尾的（上）/（完整版）
    .replace(/[「」『』《》〈〉]/gu, '')
    .replace(/[\s：:，,。.、！!？?｜|·\-—_/\\~～]+/gu, '')         // 标点与空白全去掉
    .trim()
}

/**
 * 把「媒体会话给的标题」解析成 bvid。
 *
 * 为什么需要：Windows 媒体会话只给 title/artist，**不给 URL**；而读字幕要 bvid。
 * 实测（2026-10-27）：拿真实标题去 B站 搜索，第一条就是一字不差的那一支。
 *
 * **但绝不猜**：首条归一化后必须与查询串完全相等才用；否则把候选交回去让人确认。
 * 这条跟项目里「-Match 绝不猜」是同一条规矩。
 *
 * @param title - 媒体会话给出的标题（可能带 `_哔哩哔哩_bilibili` 后缀）
 * @returns `{ ok:true, bvid, matched, candidates }` 或 `{ ok:false, status, error, candidates? }`
 */
export async function resolveBvidByTitle(title) {
  const want = normalizeTitle(title)
  if (want === '') return { ok: false, status: 'bad_args', error: '标题归一化后是空的，没法搜' }

  // 在页面里搜：和读字幕同理，脚本裸请求不被 B站 认作已登录。
  const expr = `(async () => {
    const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword='
      + encodeURIComponent(${JSON.stringify(want)})
    const r = await (await fetch(url, { credentials: 'include' })).json()
    const items = ((r.data && r.data.result) || []).slice(0, 5).map((v) => ({
      bvid: v.bvid, title: String(v.title || '').replace(/<[^>]+>/g, ''), author: v.author,
    }))
    return { code: r.code, message: r.message, items }
  })()`

  const r = await cdpEval(expr)
  if (!r.ok) return { ok: false, status: 'browser_unavailable', error: '搜标题失败：' + r.error }

  const v = r.value
  if (v === null || typeof v !== 'object' || v.code !== 0) {
    return { ok: false, status: 'upstream_error', error: `B站搜索返回 code=${String(v?.code)} ${String(v?.message ?? '')}` }
  }

  const items = Array.isArray(v.items) ? v.items : []
  const okBvid = (it) => /^[A-Za-z0-9]+$/.test(String(it.bvid ?? ''))

  // ① 归一化后完全相等 —— 最可靠，直接用
  const exact = items.find((it) => normalizeTitle(it.title) === want && okBvid(it))
  if (exact !== undefined) {
    return { ok: true, bvid: exact.bvid, matched: 'exact', title: exact.title, author: exact.author, candidates: items }
  }
  if (items.length === 0) {
    return { ok: false, status: 'not_observed', error: `按标题搜不到：「${want}」—— 可能不是 B站 视频，或标题被改过` }
  }

  // ② 一条包含另一条（一长一短，比如搜到的标题多了副标题）—— 采用，并标出来
  const first = items.find(okBvid)
  const contains = items.find((it) => {
    if (!okBvid(it)) return false
    const t = normalizeTitle(it.title)
    return t !== '' && want !== '' && (t.includes(want) || want.includes(t))
  })
  if (contains !== undefined) {
    return { ok: true, bvid: contains.bvid, matched: 'contains', title: contains.title, author: contains.author, candidates: items }
  }

  // ③ 都对不上就用搜索首条，但**标出 matched**，让下游知道这是推定而非确认。
  // 为什么可以这么做：后面还有三道路径闸（跨度 / 一致性 / 语义）在兜底 ——
  // 猜错会被拦住，而不是被当成真的。这比"停下来问人"更符合"绝大部分情况要能自己跑通"。
  if (first !== undefined) {
    return {
      ok: true, bvid: first.bvid, matched: 'first-candidate',
      title: first.title, author: first.author, candidates: items,
      note: `没有一条与「${want}」完全相等，采用搜索首条（matched=first-candidate）`,
    }
  }
  return { ok: false, status: 'identity_ambiguous', error: `搜索有结果但没有可用的 bvid，不猜；请让人选一个`, candidates: items }
}

/**
 * 一次陪看查询。
 *
 * @param opts - `{ bvid? | title?, policy, t?, start?, end?, back?, cid? }`
 *   `bvid` 与 `title` 二选一：`title` 是给「`senses_media` 只给标题」那条链准备的。
 * @returns 结构化结果：状态 + 文本 + 覆盖 + 浏览器生命周期 + 缺口；永不抛异常
 */
export async function watch(opts) {
  const t0 = Date.now()
  const policy = opts.policy
  if (policy !== 'current_prefix' && policy !== 'window' && policy !== 'full') {
    // policy 必填且没有默认值：默认全片=陪看时剧透，默认 [0,t]=刷视频时缺内容，两个都错。
    return { ok: false, status: 'bad_args', error: "policy 必填，且只能是 current_prefix / window / full" }
  }
  const hasBvid = typeof opts.bvid === 'string' && opts.bvid !== ''
  const hasTitle = typeof opts.title === 'string' && opts.title !== ''
  if (!hasBvid && !hasTitle) {
    return { ok: false, status: 'bad_args', error: '缺少 bvid，也没有 title —— 两者至少给一个' }
  }
  let bvid = opts.bvid

  // ── 浏览器生命周期：只在需要时起，只有自己起的才关 ──
  let weStarted = false
  if (!(await cdpUp())) {
    const st = browserAction('Start')
    if (st.code !== 0) {
      return {
        ok: false, status: 'browser_unavailable',
        error: '后台浏览器起不来：' + st.out,
        hint: '检查 senses\\playground\\bili-headless 是否存在、登录态是否还在（node adapters\\bili-login.mjs status）',
        elapsedMs: Date.now() - t0,
      }
    }
    weStarted = true
    if (!(await waitForBiliPage())) {
      browserAction('Stop')
      return {
        ok: false, status: 'browser_unavailable',
        error: '浏览器起来了但 15 秒内没有 bilibili 页面',
        elapsedMs: Date.now() - t0,
      }
    }
  }

  try {
    // ── 只给了标题时：先用搜索把它变成 bvid ──
    // 放在浏览器起来之后做，因为搜索要在 bilibili 页面里发（脚本裸请求不被认）。
    if (!hasBvid) {
      const resolved = await resolveBvidByTitle(opts.title)
      if (!resolved.ok) {
        return {
          ok: false, status: resolved.status, error: resolved.error,
          ...(resolved.candidates === undefined ? {} : { candidates: resolved.candidates }),
          elapsedMs: Date.now() - t0,
        }
      }
      bvid = resolved.bvid
    }

    // ── 定窗口 ──
    let win
    if (policy === 'current_prefix') {
      if (typeof opts.t !== 'number' || !Number.isFinite(opts.t) || opts.t < 0) {
        return { ok: false, status: 'bad_args', error: 'current_prefix 必须给 t（当前播放到第几秒）' }
      }
      const back = typeof opts.back === 'number' && opts.back > 0 ? opts.back : DEFAULT_BACK
      win = [Math.max(0, opts.t - back), opts.t]
    } else if (policy === 'window') {
      if (typeof opts.start !== 'number' || typeof opts.end !== 'number' || !(opts.end > opts.start)) {
        return { ok: false, status: 'bad_args', error: 'window 必须给 start 与 end，且 end > start' }
      }
      win = [opts.start, opts.end]
    } else {
      // full：先探一次拿时长，不猜
      const probe = await fetchWindow(bvid, [0, 1], { consensus: false, ...(opts.cid === undefined ? {} : { cid: opts.cid }) })
      const dur = probe?.identity?.durationSec
      if (typeof dur !== 'number' || !(dur > 0)) {
        return { ok: false, status: probe.status ?? 'upstream_error', error: '拿不到视频时长，无法定全片窗口' }
      }
      win = [0, dur]
    }

    const r = await fetchWindow(bvid, win, { ...(opts.cid === undefined ? {} : { cid: opts.cid }) })

    // ── 陪看模式：把跨过 t 的那一条整条去掉（防剧透的最后一道）──
    let segments = r.segments
    let boundaryDropped = 0
    if (policy === 'current_prefix') {
      const kept = []
      for (const s of segments) {
        if (s.end > opts.t) { boundaryDropped++; continue }
        kept.push(s)
      }
      segments = kept
    }

    const text = segments.map((s) => s.text).join('\n')
    return {
      ok: r.status === 'available' || r.status === 'partial',
      status: r.status,
      bvid,
      cid: r.identity?.cid ?? null,
      title: r.identity?.title ?? '',
      policy,
      window: win,
      t: policy === 'current_prefix' ? opts.t : null,
      coverageRatio: r.coverageRatio,
      coveredIntervals: r.coveredIntervals,
      segments: segments.length,
      boundaryDropped,
      text,
      artifact: r.artifact,
      browserStartedByUs: weStarted,
      limitations: r.limitations ?? [],
      // 给"接上来的 agent"的一句话用法约束。放在**数据旁边**而不是只在工具描述里，
      // 是因为描述在长上下文里会被稀释，而这条就在它正要用的那段文字上面。
      // 只管"别原样吐出去"，不管人设与语气（那是身份卡的事）。
      usage: '这是【字幕原素材】，不是给你念的台词：用你自己的话、按你现在的身份转述；'
        + '不要照抄、不要用字幕列表的形式复述；t 之后的内容不存在，不得推测或补写。',
      ...(r.verified === undefined ? {} : { verified: r.verified }),
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      elapsedMs: Date.now() - t0,
    }
  } finally {
    if (weStarted) browserAction('Stop')
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const num = (name) => {
    const v = opt(name)
    if (v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  // 位置参数只认"不是 --flag 也不是 flag 的值"的那些。
  // 以前直接写 argv[0]，于是 `--policy current_prefix --title-b64 …` 会把 `--policy`
  // 当成 bvid —— 一个只在"不给 bvid"时才暴露的错。
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue }   // 每个 flag 恰好带一个值
    positional.push(argv[i])
  }
  // 标题走 base64url：B站 标题里有 【】、|、() 之类，直接拼命令行会被 shell 解释。
  // base64url 只有字母数字和 -_ ，任何字符都伤不到命令行。
  const titleFromB64 = () => {
    const v = opt('title-b64')
    if (v === undefined) return undefined
    if (!/^[A-Za-z0-9_-]+$/.test(v)) return undefined
    try { return Buffer.from(v, 'base64url').toString('utf8') } catch { return undefined }
  }
  const r = await watch({
    bvid: positional[0],
    title: titleFromB64(),
    policy: opt('policy'),
    ...(num('t') === undefined ? {} : { t: num('t') }),
    ...(num('start') === undefined ? {} : { start: num('start') }),
    ...(num('end') === undefined ? {} : { end: num('end') }),
    ...(num('back') === undefined ? {} : { back: num('back') }),
    ...(num('cid') === undefined ? {} : { cid: num('cid') }),
  })
  console.log(JSON.stringify(r, null, 2))
  process.exitCode = r.ok ? 0 : 1
}
