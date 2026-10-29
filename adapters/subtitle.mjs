#!/usr/bin/env node
// subtitle.mjs —— 取 B站 点播视频的字幕，围绕「目标时间窗口」，并且**经浏览器取元数据**。
//
// ── 这一版为什么又改了 ──────────────────────────────────────────────────────
//
// 实测走过的四版，每版错在哪：
//
// ① 把「一次请求拿到字幕」当确定性事实   → 同视频 8 次跑出 12~2053 行，前提是假的
// ② 以为「行数越多越完整」，谁大用谁     → 238 行可能比 2053 行覆盖更全；行数不是完整性
// ③ 改成窗口覆盖率 + 多状态 + 取证日志   → 判据对了，但还是拿不到
// ④ **这一版：换数据来源**
//
// 第 ④ 版的依据是一次对照实验（同一视频、同一账号、同一 cookie）：
//
//                      脚本裸调 fetch          受控 Edge 页面里 fetch
//   login_mid          0                     351482410
//   need_login_subtitle true                  false
//   字幕轨              0 条                  9 条
//
// **结论：B站 不认脚本手工拼的 Cookie 头；它认浏览器自己发起的请求。**
// 所以元数据（轨列表 / subtitle_url）必须从浏览器上下文里取。
//
// 顺带纠正两个我自己的错：
//   · `data.is_login` 这个字段**根本不存在**（一直是 undefined），我据此判"未登录"全错。
//     真正的信号是 `login_mid` 与 `need_login_subtitle`。
//   · 所以「is_login 说谎」这个说法不成立；是我读错了字段名。
//
// ── 三个不许（沿用） ────────────────────────────────────────────────────────
//   不许把「没观察到」写成「没有」        → not_observed
//   不许拿整片行数冒充窗口成功            → 用覆盖率，没覆盖就是 partial
//   不许把「字幕区间覆盖够」包装成「理解准确」
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node subtitle.mjs win <bvid> <start> <end> [--cid N] [--langs zh,ai-zh] [--out 目录]
//   node subtitle.mjs slice <jsonl> <t>
//   node subtitle.mjs probe <bvid>
//
// 依赖：一个开着 bilibili.com 页面的受控 Edge（--remote-debugging-port 9223）。
// 取不到就返回 `browser_unavailable`，**不退回脚本裸调**——那条路已验证不被认。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REFERER = 'https://www.bilibili.com/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const CDP_PORT = Number(process.env.BILI_CDP_PORT ?? 9224)

/** 重试参数：初始工程值，不是实测最优。 */
const MAX_ATTEMPTS = 4
// 退避故意很短。原来写的是 [0,600,1200,2400]（累计 4.2 秒），那是为"页面没热"设计的；
// 但实测的主要失败原因是**接口间歇性返回别的视频的正文**，等待并不能让它变好，
// 只会让用户干等 5–7 秒。现在靠"按身份缓存"保证第二次就是毫秒级，冷路径短退避即可。
const BACKOFF_MS = [0, 250, 500, 1000]
const TOTAL_BUDGET_MS = 20000

/** 窗口覆盖率验收阈值。实验参数，不是"内容完整"的事实声明。 */
const COVERAGE_OK = 0.8

/**
 * 正文跨度与视频时长的自洽判据（见下方"身份自洽闸"）。
 * 实测：正确的正文跨度是时长的 0.99；所有被串进来的正文都 ≤ 0.66 或 > 5。
 * 0.8 卡在两者之间，留出的余量用于"片尾没说话"这类合法情况，超过就拒绝而不是猜。
 */
const SPAN_RATIO_MIN = 0.8
/** 正文允许比视频长出的秒数（字幕时间戳有进位误差）。 */
const SPAN_OVERFLOW_SEC = 30

/** 正文缓存目录（可选）。**URL 有效期未知**，所以同时记 fetchedAt。 */
const CACHE_DIR = process.env.BILI_CACHE_DIR ?? ''
const bodyCache = new Map()

function cachePath(url) {
  if (CACHE_DIR === '') return null
  return join(CACHE_DIR, `${createHash('sha1').update(url).digest('hex')}.json`)
}

function cacheGet(url) {
  if (bodyCache.has(url)) return bodyCache.get(url)
  const p = cachePath(url)
  if (p === null || !existsSync(p)) return undefined
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (Array.isArray(j?.rows)) { bodyCache.set(url, j.rows); return j.rows }
  } catch { /* 缓存坏了就当没有 */ }
  return undefined
}

function cacheSet(url, rows) {
  bodyCache.set(url, rows)
  const p = cachePath(url)
  if (p === null) return
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(p, JSON.stringify({ url, fetchedAt: new Date().toISOString(), rows }))
  } catch { /* 写不进缓存不影响本次结果 */ }
}

// ── 按「视频身份」的正文缓存 ────────────────────────────────────────────────
//
// 为什么不能只按 URL 缓存：`subtitle_url` 每次调用都带新签名，URL 一直在变，
// 按 URL 缓存等于**永远不命中**（这个坑今天才量出来）。
// 真正稳定的是「哪个视频的哪条语言轨」—— 所以键用 bvid + cid + lan。
//
// 为什么必须有：实测（2026-10-27）同一视频同一窗口连取 10 次，
// **只有 3 次拿到正确正文**，5 次是别的视频（被跨度闸拒掉），2 次根本没正文。
// 30% 的成功率意味着"每次问都现抓"是不可用的；一旦拿到一次对的就落盘，
// 之后陪看无论问多少遍都是 0 网络、毫秒级。
// 主目录在工作区里（人看得见、好排查）；写不进去就退到系统临时目录。
// 为什么要有回退：实测在 workspace-write 的沙箱会话里 `work\subtitles` 写不进（EPERM），
// 而缓存失效的后果不是"慢一点"，是**每次都要重新赌 25% 的正确率** —— 那一条直接毁掉可用性。
const PRIMARY_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'work', 'subtitles')
const FALLBACK_CACHE_DIR = join(tmpdir(), 'senses-subtitles')

/** 缓存文件名：只留安全字符，避免 bvid/lan 里的怪字符变成路径穿越。 */
function bodyCacheFile(dir, bvid, cid, lan) {
  const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '_')
  return join(dir, `${safe(bvid)}_${safe(cid)}_${safe(lan)}.json`)
}

/** 两个目录都查（主目录优先）。 */
function bodyCacheGet(bvid, cid, lan) {
  for (const dir of [PRIMARY_CACHE_DIR, FALLBACK_CACHE_DIR]) {
    try {
      const p = bodyCacheFile(dir, bvid, cid, lan)
      if (!existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (Array.isArray(j?.rows) && j.rows.length > 0) return j.rows
    } catch { /* 这个目录读不了，试下一个 */ }
  }
  return null
}

/** 写到第一个能写的目录。 */
function bodyCacheSet(bvid, cid, lan, rows, hash) {
  for (const dir of [PRIMARY_CACHE_DIR, FALLBACK_CACHE_DIR]) {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(bodyCacheFile(dir, bvid, cid, lan), JSON.stringify({
        bvid, cid, lan, hash, savedAt: new Date().toISOString(), rows,
      }))
      return
    } catch { /* 这个目录写不了，试下一个 */ }
  }
}

/**
 * 在受控 Edge 的 bilibili.com 页面里求值一段 async 表达式。
 *
 * 为什么必须走页面：脚本直接 fetch 时 B站 不认手工拼的 Cookie 头
 * （login_mid=0，字幕轨 0 条）；同一时刻页面里 fetch 能拿到 9 条轨。
 *
 * @param expression - 一段返回可 JSON 化值的 async IIFE 源码
 * @returns `{ ok, value?, error? }`；永不抛异常
 */
export async function cdpEval(expression) {
  let list
  try {
    list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(4000) })).json()
  } catch (error) {
    return { ok: false, error: `CDP 不可用: ${String(error?.message ?? error)}` }
  }
  const page = list.find((t) => t.type === 'page' && String(t.url ?? '').includes('bilibili.com'))
  if (page === undefined) return { ok: false, error: 'CDP 里没有 bilibili.com 页面 —— 受控 Edge 需要开着一个 B站 页面' }

  return await new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => { try { ws.close() } catch { /* 已关 */ } ; done({ ok: false, error: 'CDP 求值超时 25s' }) }, 25000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    })))
    ws.addEventListener('error', () => { clearTimeout(timer); done({ ok: false, error: 'CDP WebSocket 失败' }) })
    ws.addEventListener('message', (event) => {
      let m
      try { m = JSON.parse(String(event.data)) } catch { return }
      if (m.id !== 1) return
      clearTimeout(timer)
      ws.addEventListener('close', () => {
        if (m.error) done({ ok: false, error: `CDP: ${JSON.stringify(m.error)}` })
        else if (m.result?.exceptionDetails) done({ ok: false, error: `页面内异常: ${String(m.result.exceptionDetails.text)}` })
        else done({ ok: true, value: m.result?.result?.value })
      }, { once: true })
      try { ws.close() } catch { /* 已关 */ }
    })
  })
}

// ── view 元数据的进程内短缓存（检查点）──────────────────────────────────────
//
// 为什么只缓存 view：实测 8/8 次探测里 cid / 时长 / 标题全对，错的只有 player/v2 返回的
// subtitle_url（同一 URL 的内容稳定，只有换 URL 才有机会拿到对的）。重试若连 view 一起
// 重来，每轮都白付一次往返；缓存它之后，每轮只重赌真正不可信的那一步。
//
// 为什么 TTL 只有 45 秒：同一个 bvid 的 cid / 时长 / 标题几乎不变，但标题和分 P 可能被改。
// 短 TTL 让下一轮陪看看到新值，同时 refresh:true 还能显式绕过（整体重来不能读旧值）。
const VIEW_TTL_MS = 45000
const viewCache = new Map() // bvid → { at, identity }

/**
 * 取某个媒体的元数据与轨列表 —— **经浏览器**。
 *
 * @param bvid - 视频 BV 号
 * @param opts - `{ refresh?, cid? }`：refresh 为 true 时绕过 view 缓存；
 *   cid 指定分 P（多 P 视频必须给，否则只能取到第 1P）
 * @returns `{ ok, identity?, tracks?, loginMid?, needLoginSubtitle?, asrLanguage?, error? }`
 */
export async function probeViaBrowser(bvid, opts = {}) {
  // 缓存键必须带 cid：同一个 bvid 的不同分 P 是不同内容，只按 bvid 缓存会拿错 P。
  const wantCid = opts.cid === undefined || opts.cid === null ? null : Number(opts.cid)
  const key = String(bvid) + '|' + (wantCid === null ? '' : String(wantCid))
  const hit = opts.refresh === true ? undefined : viewCache.get(key)
  const reused = hit !== undefined && Date.now() - hit.at < VIEW_TTL_MS ? hit.identity : undefined
  if (hit !== undefined && reused === undefined) viewCache.delete(key)

  // 两段页面代码只差「元数据从哪来」：命中缓存就不发 view，没命中才先探 view。
  // 指定了 cid 时，时长必须取**那个分 P 的**，不能沿用 view 返回的第 1P 时长 ——
  // 否则跨度闸会拿错的时长去比较，把正确正文判成"别的视频"。
  const head = reused === undefined
    ? `const v = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + ${JSON.stringify(String(bvid))}, { credentials: 'include' })).json()
    if (!v || v.code !== 0) return { ok: false, stage: 'view', code: v && v.code, message: v && v.message }
    const aid = v.data.aid
    const allPages = v.data.pages || []
    const wantCid = ${wantCid === null ? 'null' : wantCid}
    const pick = wantCid === null ? null : allPages.find(function (p) { return Number(p.cid) === wantCid })
    if (wantCid !== null && !pick) return { ok: false, stage: 'cid', message: '指定的 cid 不属于这个视频（共 ' + allPages.length + ' 个分 P）' }
    const cid = pick ? Number(pick.cid) : v.data.cid
    const identity = { bvid: v.data.bvid, aid, cid, title: v.data.title, owner: (v.data.owner||{}).name || '', durationSec: pick ? pick.duration : v.data.duration, pages: allPages.length, pageIndex: pick ? pick.page : 1, partTitle: pick ? String(pick.part || '') : '' }`
    : `const aid = ${JSON.stringify(reused.aid)}
    const cid = ${JSON.stringify(reused.cid)}
    const identity = ${JSON.stringify(reused)}`

  const expr = `(async () => {
    ${head}
    const j = await (await fetch('https://api.bilibili.com/x/player/v2?aid=' + aid + '&cid=' + cid, { credentials: 'include' })).json()
    if (!j || j.code !== 0) return { ok: false, stage: 'player', code: j && j.code, message: j && j.message }
    const d = j.data || {}
    return {
      ok: true,
      identity,
      loginMid: d.login_mid,
      needLoginSubtitle: d.need_login_subtitle,
      asrLanguage: d.asr_language,
      ocrLanguage: d.ocr_language,
      tracks: ((d.subtitle && d.subtitle.subtitles) || []).map(t => ({
        lan: t.lan, lanDoc: t.lan_doc, aiType: t.ai_type, url: t.subtitle_url || ''
      }))
    }
  })()`
  const r = await cdpEval(expr)
  if (!r.ok) return { ok: false, error: r.error }
  const v = r.value
  if (v === null || typeof v !== 'object') return { ok: false, error: '页面返回了非对象' }
  if (v.ok !== true) {
    // cid 不属于这个视频是**确定性**失败：重试无意义，必须立刻让调用方改参数。
    // view / player 的阶段失败仍按"可能瞬时"处理（接口会抖）。
    return {
      ok: false,
      error: `${v.stage} 阶段失败 code=${v.code} ${v.message ?? ''}`.trim(),
      ...(v.stage === 'cid' ? { fatal: true } : {}),
    }
  }
  // 只在真的从 view 取到时记检查点。view 阶段失败不会留下半截元数据。
  if (reused === undefined) {
    // 宿主可能是长命进程：过期条目只在被再次读到时清，所以这里封个上限。
    if (viewCache.size >= 64) viewCache.clear()
    viewCache.set(key, { at: Date.now(), identity: v.identity })
  }
  return {
    ok: true,
    identity: v.identity,
    loginMid: v.loginMid,
    needLoginSubtitle: v.needLoginSubtitle,
    asrLanguage: v.asrLanguage,
    ocrLanguage: v.ocrLanguage,
    tracks: Array.isArray(v.tracks) ? v.tracks : [],
  }
}

/** 从节点侧取正文（CDN 不要求身份；实测同一 URL 连抓 6 次完全一致）。 */
async function fetchBody(url) {
  const abs = String(url).startsWith('//') ? `https:${url}` : String(url)
  let res
  try {
    res = await fetch(abs, { headers: { 'User-Agent': UA, Referer: REFERER }, signal: AbortSignal.timeout(15000) })
  } catch (error) {
    return { ok: false, error: `network: ${String(error?.message ?? error)}` }
  }
  if (!res.ok) return { ok: false, error: `http ${res.status}`, httpStatus: res.status }
  let j
  try { j = await res.json() } catch { return { ok: false, error: '正文不是 JSON', httpStatus: res.status } }
  const raw = Array.isArray(j?.body) ? j.body : null
  if (raw === null) return { ok: false, error: '正文没有 body 数组', httpStatus: res.status }
  const rows = raw.map((r) => ({
    start: Number(r.from), end: Number(r.to),
    text: String(r.content ?? '').replace(/\r?\n/g, ' ').trim(),
  })).filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && r.text !== '')
  return { ok: true, rows, abs }
}

/**
 * 正文跨度是否与视频时长自洽 —— 用来识别"返回的是别的视频的字幕"。
 *
 * 实测同一支 546 秒的视频，接口间歇性给出的正文跨度是 15.38 / 29.24 / 113.44 / 356.98 /
 * 351.56 / 2937.16 秒，而正确的是 540.44 秒（占比 0.99）。0.8 这条线把两者分开。
 *
 * @param span - 正文最后一条的结束时间（秒）
 * @param durationSec - 视频时长（秒）
 * @returns 是否放行；时长缺失或非正时放行 —— 没有参照就不该凭这个判据拒绝
 */
export function spanAllows(span, durationSec) {
  const dur = Number(durationSec)
  if (!Number.isFinite(dur) || dur <= 0) return true
  const s = Number(span)
  if (!Number.isFinite(s)) return false
  return s / dur >= SPAN_RATIO_MIN && s <= dur + SPAN_OVERFLOW_SEC
}

/**
 * 算「字幕区间并集」与目标窗口的交集时长 / 窗口时长。
 * @param segments - `[{start,end}]`
 * @param win - `[start, end]`
 * @returns `{ ratio, covered }`
 */
function coverage(segments, win) {
  const [ws, we] = win
  const dur = we - ws
  if (!(dur > 0)) return { ratio: 0, covered: [] }
  const clipped = segments
    .map((s) => [Math.max(s.start, ws), Math.min(s.end, we)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  const covered = []
  for (const iv of clipped) {
    const last = covered[covered.length - 1]
    if (last !== undefined && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else covered.push([iv[0], iv[1]])
  }
  return { ratio: Math.min(1, covered.reduce((t, [a, b]) => t + (b - a), 0) / dur), covered }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 两次独立取数、**正文完全一致才放行**（一致性闸）。
 *
 * 为什么必须有：实测（2026-10-27）同一支视频连取 4 次，得到 3 次 hash=f3d5d1a / 238 行，
 * 1 次被跨度闸拒掉；而更早的一次坏样本**通过了跨度闸**并返回 status=available ——
 * 正文是别的视频的台词（"毫无意义 / 说实话 / 我上学的时候还真的怀疑过自己…"），
 * 读起来和真字幕一模一样，不报错。
 *
 * 结论：**跨度自洽只能挡住"时长差很多"的串台，挡不住"时长接近"的串台**。
 * 唯一可靠的信号是"多取一次，看它稳不稳"。
 *
 * @param bvid - 视频 BV 号
 * @param win - `[start, end]` 秒，必填
 * @param opts - 同 fetchWindowOnce；`consensus: false` 关掉本闸（只给"探时长"那种调用用）
 * @returns 第一次的结果；一致时带 `verified`，不一致时 `status: identity_suspect`
 */
export async function fetchWindow(bvid, win, opts = {}) {
  if (opts.consensus === false) return await fetchWindowOnce(bvid, win, opts)

  // 最多取 4 次，**同一次 hash 出现两遍就采用它**。
  //
  // 为什么不是"取两次必须相同"：实测串台率约 25%–40%，那样会有近一半的调用被拒，
  // 陪看直接一半失败。取到两票一致就停，既挡住串台，又不会把正常情况也毙掉。
  // 代价最多 4 次取样（每次一个 player/v2 + 一份正文），实测单次几百毫秒到 2 秒。
  // 实测（2026-10-27）重新探 8 次只有 2 次拿到正确正文（约 25%）—— 错的 URL 各自返回
  // 稳定但错误的内容。所以冷路径必须多给几次机会；一旦两次一致就停并落盘，之后 0 网络。
  // 6 次取样时"至少拿到一次正确"约 82%。
  const maxDraws = Number.isFinite(opts.consensusDraws) ? opts.consensusDraws : 6
  const counts = new Map()
  const statuses = []
  let first = null
  let lastUsable = null

  /** 剥离仅供内部落盘用的整轨正文，别让它流到调用方（keepRows 明确要求时保留）。 */
  const stripRows = (r) => {
    if (opts.keepRows === true) return r
    if (r.bodyRows === undefined) return r
    const { bodyRows: _drop, ...rest } = r
    return rest
  }

  for (let i = 0; i < maxDraws; i++) {
    // **每次取样只给 1 次尝试**：重试由本层负责，内层不再重试（否则耗时呈乘法）。
    const r = await fetchWindowOnce(bvid, win, { ...opts, maxAttempts: 1, returnRows: true })
    // 确定性失败（参数错、cid 不属于这个视频）重试没有意义 —— 立刻交回，别耗 6 轮。
    if (r.fatal === true) return stripRows(r)
    statuses.push(r.status)
    if (first === null) first = r
    // 命中「按视频身份」的缓存 → 这条正文是**两次独立取样一致后**才写进去的，
    // 不需要再做一致性取样，直接放行（陪看时这是常态路径：0 网络）。
    if (r.cacheHit === true && (r.status === 'available' || r.status === 'partial')) {
      return stripRows({ ...r, verified: 'identity-cache' })
    }
    if (r.status !== 'available' && r.status !== 'partial') continue
    const h = r.artifact?.bodyHash ?? ''
    if (h === '') continue
    lastUsable = r
    const entry = counts.get(h) ?? { count: 0, sample: r }
    entry.count += 1
    counts.set(h, entry)
    if (entry.count >= 2) {
      // **两次独立取样一致 → 这才算确认，落盘。**
      // 实测（2026-10-27）同一个 URL 下载多次内容恒定，所以"同 hash 出现两次"
      // 意味着两次独立探针都指向了同一份正文 —— 这才够格进缓存。
      if (!opts.refresh) {
        bodyCacheSet(bvid, r.identity?.cid ?? '', r.artifact?.lan ?? '', r.bodyRows ?? [], h)
      }
      return stripRows({ ...r, verified: `consensus:${entry.count}-of-${i + 1}-draws` })
    }
  }

  const seen = [...counts.entries()].map(([h, e]) => `${h}×${e.count}`)
  const census = { draws: maxDraws, seen, statuses }
  const base = lastUsable ?? first
  if (base === null) return { ok: false, status: 'browser_unavailable', reason: '一致性闸：一次都没取到结果', consensus: census }
  if (counts.size === 0) {
    // 一次都没拿到**可用**正文：保留底层状态（not_observed / fetch_failed / upstream_error）。
    // 以前这里统一改写成 identity_suspect —— 那是谎报：根本没看到可疑内容，只是没拿到。
    // 状态里同时带上每次取样的结果，才分得清"全没 URL"和"全错内容"。
    return stripRows({ ...base, consensus: census })
  }
  return stripRows({
    ...base, ok: false, status: 'identity_suspect',
    reason: `一致性闸：${maxDraws} 次取样内没有两次相同（观测 ${seen.join(' / ') || '无正文'}），拒绝`,
    consensus: census,
  })
}

/**
 * 取一个媒体在目标窗口内的字幕证据（单次）。
 * @param bvid - 视频 BV 号
 * @param win - `[start, end]` 秒，必填
 * @param opts - `{ cid?, langs? }`
 * @returns 状态 + 证据 + 覆盖 + 每次尝试取证；永不抛异常
 */
async function fetchWindowOnce(bvid, win, opts = {}) {
  const langs = opts.langs ?? ['zh', 'ai-zh', 'zh-CN', 'zh-Hans']
  const t0 = Date.now()
  const attempts = []
  const budgetLeft = () => Date.now() - t0 < TOTAL_BUDGET_MS

  // 刚起好的浏览器会有一小段"页面在了但还不能求值"的窗口：实测表现为
  // `Failed to fetch`（文档还没提交，fetch 从 opaque origin 发出）。
  // 这不是"浏览器不可用"，是还没热。所以先重试，别立刻判死。
  let first = null
  const readyDeadline = Date.now() + 12000
  for (let k = 0; k < 24; k++) {
    first = await probeViaBrowser(bvid, { refresh: opts.refresh === true, cid: opts.cid })
    if (first.ok) break
    const transient = /Failed to fetch|没有可用的 bilibili 页面|CDP 不可用|Failed to parse URL/.test(String(first.error ?? ''))
    if (!transient || Date.now() > readyDeadline) break
    await sleep(500)
  }
  if (!first.ok) {
    // `fatal` 是**确定性**失败（比如 cid 不属于这个视频）：重试一百次也是同一个结果，
    // 而且它不是"浏览器不可用"。混在一起会让调用方以为环境坏了、也白白重试。
    return {
      status: first.fatal === true ? 'bad_args' : 'browser_unavailable',
      bvid, reason: first.error,
      ...(first.fatal === true ? { fatal: true } : {}),
      requestedWindow: win, coverageRatio: 0, coveredIntervals: [], segments: [], artifact: null,
      attempts, elapsedMs: Date.now() - t0,
      limitations: ['元数据必须经浏览器获取；脚本直接请求不被 B站 认作登录用户'],
    }
  }

  const identity = first.identity
  if (identity.pages > 1 && opts.cid === undefined) {
    return {
      status: 'identity_ambiguous', bvid, identity,
      reason: `多分P（${identity.pages}），必须用 --cid 指定；不替调用方猜`,
      requestedWindow: win, coverageRatio: 0, coveredIntervals: [], segments: [], artifact: null,
      attempts, elapsedMs: Date.now() - t0,
    }
  }

  let meta = first
  let best = null
  let suspect = null
  // 内层尝试次数可被外层覆盖。**一致性闸在外层重试时，内层必须退化成 1 次** ——
  // 否则"4 次取样 × 4 次尝试 + 4.2 秒退避"会变成 16 次探针、十几秒（实测 14 秒）。
  // 重试只该有一层。
  const maxAttempts = Number.isFinite(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : MAX_ATTEMPTS
  for (let i = 0; i < maxAttempts; i++) {
    if (!budgetLeft()) { attempts.push({ attempt: i + 1, result: 'budget_exhausted' }); break }
    if (i > 0) {
      await sleep(BACKOFF_MS[i] + Math.floor(Math.random() * 200))
      meta = await probeViaBrowser(bvid, { refresh: opts.refresh === true, cid: opts.cid })
      if (!meta.ok) { attempts.push({ attempt: i + 1, result: 'fetch_failed', detail: meta.error }); continue }
    }
    const rec = {
      attempt: i + 1,
      loginMid: meta.loginMid ?? null,
      needLoginSubtitle: meta.needLoginSubtitle ?? null,
      asrLanguage: meta.asrLanguage ?? '',
      trackCount: meta.tracks.length,
      tracks: meta.tracks.map((t) => ({ lan: t.lan, aiType: String(t.aiType ?? ''), hasUrl: t.url !== '' })),
    }
    if (meta.tracks.length === 0) {
      rec.result = 'not_observed'
      rec.detail = `浏览器内 login_mid=${meta.loginMid ?? '?'}、need_login_subtitle=${meta.needLoginSubtitle ?? '?'}，本次 0 条轨`
      attempts.push(rec); continue
    }
    const usable = meta.tracks.filter((t) => t.url !== '')
    const preferred = usable.filter((t) => langs.includes(String(t.lan ?? '')))
    const candidates = preferred.length > 0 ? preferred : usable
    if (candidates.length === 0) { rec.result = 'fetch_failed'; rec.detail = '轨存在但没有 subtitle_url'; attempts.push(rec); continue }

    for (const track of candidates) {
      let rows
      let fromIdentityCache = false
      // 先查「按视频身份」的缓存：bvid + cid + 语言轨。这才是稳定的键。
      const idCached = opts.refresh === true ? null : bodyCacheGet(bvid, identity.cid, track.lan)
      const cached = cacheGet(track.url)
      if (idCached !== null) { rows = idCached; fromIdentityCache = true; rec.identityCacheHit = true }
      else if (cached !== undefined) { rows = cached; rec.cacheHit = true }
      else {
        const b = await fetchBody(track.url)
        if (!b.ok) { rec.bodyError = b.error; continue }
        rows = b.rows
        cacheSet(track.url, rows)
      }
      // ── 身份自洽闸：正文的跨度必须和视频时长对得上 ──
      // 实测同一个 aid+cid 会**间歇性返回别的视频的正文**，而且不报错。同一支 546 秒的视频上出现过：
      //   7 行/15.38s（三国）、12 行/29.24s、51 行/113.44s、160 行/356.98s、
      //   219 行/351.56s、1476 行/2937.16s；只有 238 行/540.44s 那几次是对的。
      // 拿错比拿不到更糟 —— 错的字幕会被当成真的去回答用户，看不出错。所以这里 fail-closed。
      const dur = Number(identity.durationSec)
      const span = rows.length > 0 ? rows[rows.length - 1].end : 0
      const spanRatio = dur > 0 ? span / dur : null
      if (rows.length > 0 && !spanAllows(span, dur)) {
        suspect = {
          lan: String(track.lan ?? ''), lines: rows.length, span,
          durationSec: dur, spanRatio: spanRatio === null ? null : Number(spanRatio.toFixed(3)),
        }
        rec.identitySuspect = suspect
        continue
      }

      const cov = coverage(rows, win)
      const hash = createHash('sha256').update(rows.map((r) => `${r.start}|${r.end}|${r.text}`).join('\n')).digest('hex').slice(0, 16)
      // 这里**不写**按身份的缓存：跨度闸会放过"时长接近"的错正文（实测有过），
      // 而同一 URL 的内容是稳定的 —— 一旦错正文落盘，后面每次读缓存都会"自我确认"。
      // 落盘统一由外层在"两次独立取样一致"之后做。
      const cand = {
        lan: String(track.lan ?? ''), lanDoc: String(track.lanDoc ?? ''),
        isAi: String(track.aiType ?? '0') !== '0' || String(track.lan ?? '').startsWith('ai-'),
        bodyHash: hash, lineCount: rows.length,
        coverageRatio: cov.ratio, coveredIntervals: cov.covered,
        firstStart: rows.length > 0 ? rows[0].start : null,
        lastEnd: rows.length > 0 ? rows[rows.length - 1].end : null,
        rows,
      }
      if (best === null || cand.coverageRatio > best.coverageRatio) best = cand
      if (cand.coverageRatio >= COVERAGE_OK) break
    }
    rec.bestCoverage = best === null ? 0 : Number(best.coverageRatio.toFixed(3))
    rec.result = best !== null && best.coverageRatio >= COVERAGE_OK ? 'available' : 'partial'
    attempts.push(rec)
    if (best !== null && best.coverageRatio >= COVERAGE_OK) break
  }

  const finalRatio = best === null ? 0 : best.coverageRatio
  let status
  if (best !== null && finalRatio >= COVERAGE_OK) status = 'available'
  else if (best !== null) status = 'partial'
  // **危险信号优先**：这次拿到过"别的视频的正文"，比"这次平台没给"更该报警。
  // 以前 not_observed 排前面，会把 identity_suspect 盖掉 —— 而两者的处理办法完全不同。
  else if (suspect !== null) status = 'identity_suspect'
  else if (attempts.some((a) => a.result === 'not_observed')) status = 'not_observed'
  else if (attempts.some((a) => a.result === 'fetch_failed')) status = 'fetch_failed'
  else status = 'upstream_error'

  return {
    status, bvid, identity, requestedWindow: win,
    coverageRatio: Number(finalRatio.toFixed(3)),
    coveredIntervals: best === null ? [] : best.coveredIntervals,
    segments: best === null ? [] : best.rows.filter((r) => r.end > win[0] && r.start < win[1]),
    artifact: best === null ? null : {
      lan: best.lan, lanDoc: best.lanDoc, isAi: best.isAi, bodyHash: best.bodyHash,
      lineCount: best.lineCount, firstStart: best.firstStart, lastEnd: best.lastEnd,
    },
    // 内部用：外层做一致性确认后要把**整轨正文**落盘，而 artifact 故意不含 rows（返回体要小）。
    // 这个字段只在 returnRows 打开时出现，外层剥离后才交给调用方。
    ...(opts.returnRows === true && best !== null ? { bodyRows: best.rows } : {}),
    limitations: [
      '字幕由平台/上传者提供，未经校验；准确性未验证',
      '覆盖率是「字幕时间区间」的覆盖，不是「语义完整」或「正确」',
      '未覆盖区间的内容未知，不得据标题或其他线索补写',
      '元数据取自受控浏览器的登录上下文',
    ],
    attempts,
    cacheHit: attempts.some((a) => a.identityCacheHit === true),
    // **只在真的失败时才带 suspect / reason。**
    // 踩过的坑：早期尝试出现过坏样本、后面又拿到了好样本时，`suspect` 变量还留着，
    // 于是出现了 `status: available` 却附一条「已拒绝」的 reason —— 自述自相矛盾，
    // 读的人会以为这次失败了。成功的返回里不该有任何"拒绝"字样。
    ...(suspect === null || status === 'available' || status === 'partial' ? {} : {
      suspect,
      reason: `正文跨度与视频时长不符：${suspect.lines} 行 / ${suspect.span} 秒，而视频长 ${suspect.durationSec} 秒`
        + `（占比 ${suspect.spanRatio}，下限 ${SPAN_RATIO_MIN}）。这次返回的字幕可能属于别的视频，已拒绝。`,
    }),
    elapsedMs: Date.now() - t0,
  }
}

/**
 * 机械切片：policy=current_prefix。`end > t` 的整条丢掉，不按比例截断。
 * 理由：一条字幕的文字与其内部时间不是线性对应，截一半等于泄露后半句。
 */
export function slice(doc, t) {
  const all = Array.isArray(doc?.segments) ? doc.segments : []
  const tSafe = Math.max(0, Number(t) || 0)
  const allowed = []
  let boundaryDropped = 0
  let startedAfter = 0
  for (const row of all) {
    if (row.start >= tSafe) { startedAfter++; continue }
    if (row.end > tSafe) { boundaryDropped++; continue }
    allowed.push(row)
  }
  return {
    policy: 'current_prefix', t: tSafe, lines: allowed.length,
    gaps: { boundaryDropped, notYetStarted: startedAfter, total: all.length },
    text: allowed.map((r) => r.text).join('\n'),
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// 只有直接 
// 只有当本文件被直接运行时才执行 CLI；被 import 时什么都不做。
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}

if (cmd === 'win') {
  const bvid = argv[1]
  const start = Number(argv[2])
  const end = Number(argv[3])
  if (bvid === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    console.error('用法: node subtitle.mjs win <bvid> <start秒> <end秒> [--cid N] [--out 目录]')
    process.exitCode = 64
  } else {
    const cidOpt = opt('cid', undefined)
    const langsOpt = opt('langs', undefined)
    const r = await fetchWindow(bvid, [start, end], {
      ...(cidOpt === undefined ? {} : { cid: Number(cidOpt) }),
      ...(langsOpt === undefined ? {} : { langs: langsOpt.split(',').map((s) => s.trim()).filter(Boolean) }),
    })
    const outDir = opt('out', '')
    if (outDir !== '') {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, `${bvid}-${start}-${end}.json`), JSON.stringify(r, null, 2))
    }
    console.log(JSON.stringify({
      status: r.status, bvid: r.bvid, cid: r.identity?.cid,
      window: r.requestedWindow, coverageRatio: r.coverageRatio,
      coveredIntervals: r.coveredIntervals, segments: r.segments.length, artifact: r.artifact,
      attempts: r.attempts.map((a) => ({ n: a.attempt, result: a.result, tracks: a.trackCount ?? null, loginMid: a.loginMid ?? null, cacheHit: a.cacheHit ?? false, best: a.bestCoverage ?? null })),
      elapsedMs: r.elapsedMs,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
    }, null, 2))
    process.exitCode = r.status === 'available' ? 0 : 1
  }
} else if (cmd === 'slice') {
  const raw = readFileSync(argv[1], 'utf8').replace(/^\uFEFF/, '')
  const rows = raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l.replace(/^\uFEFF/, '')))
  console.log(JSON.stringify(slice({ segments: rows }, Number(argv[2])), null, 2))
} else if (cmd === 'probe') {
  const r = await probeViaBrowser(argv[1])
  console.log(JSON.stringify(r.ok
    ? { ok: true, identity: r.identity, loginMid: r.loginMid, needLoginSubtitle: r.needLoginSubtitle, tracks: r.tracks.map((t) => ({ lan: t.lan, aiType: t.aiType, hasUrl: t.url !== '' })) }
    : r, null, 2))
  process.exitCode = r.ok ? 0 : 1
} else {
  console.error('子命令: win | slice | probe')
  process.exitCode = 64
}
}
