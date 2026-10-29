#!/usr/bin/env node
// browse.mjs —— 在**受控 Edge**（默认 9224）上做通用网页操作：列页 / 打开 / 读正文 / 点击 / 滚动 / 截图。
//
// 用法：node browse.mjs <op> [参数]
//   pages                    列出 CDP 里的 page（[{id,title,url}]）
//   open <url>               Page.navigate + 等 readyState=complete（15s）
//   read [maxChars]          取 document.body.innerText，默认上限 8000 字
//   click <selector>         document.querySelector(sel).click()，不许猜别的元素
//   scroll <px>              window.scrollBy(0, px)，回 scrollY
//   shot <path>              Page.captureScreenshot(png) → 写文件
//
// stdout 只输出**一行 JSON**；诊断信息一律走 stderr。
// 失败用 process.exitCode（不是 process.exit）。
//
// ── 为什么这么写（都是踩过的）─────────────────────────────────────────────
//
// 1. **不能用 process.exit()**：WebSocket 还没关干净时退出会触发 libuv 断言
//    （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码 -1073740791）。
//    所以每个 CDP 调用都等到 ws 的 close 事件再 resolve，最后只设 exitCode。
// 2. **只等端口不够**：实测 CDP 端口 0.73s 就绪，而页面 0.87s 才出现；
//    中间那一百多毫秒里发指令会报「没有页面」。所以启动后必须等**页面**。
// 3. **页面优先 bilibili**：这台 Edge 的登录态挂在 bilibili.com 这个 origin 上，
//    导航/求值都在这个页面里做最稳。没有 bilibili 页时兜底用第一个 page，
//    否则 `open example.com` 之后就再也找不到页面了。
// 4. **一次调用一个 WebSocket**：照抄 subtitle.mjs 的做法。CDP 支持多路复用，
//    但每个 CLI 进程只活几秒，连接开销可以忽略，换来的是没有跨调用状态要清理。
//    代价：`open` 之后 `read` 是另一个进程、另一个连接 —— 因为 CLI 无状态，
//    所以多标签页时"我导航的是哪一个"无法保证。单页场景（本工具的用法）没问题。

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SENSES = dirname(HERE)
const BROWSER_PS = join(SENSES, 'bili-browser.ps1')
const PORT = Number(process.env.BILI_CDP_PORT ?? 9224)

const CDP_HTTP = (path) => `http://127.0.0.1:${PORT}${path}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 端口上有没有 CDP。 */
async function cdpUp() {
  try {
    const r = await fetch(CDP_HTTP('/json/version'), { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

/** 原始 target 列表（含 webSocketDebuggerUrl）；拿不到就当空。 */
async function rawTargets() {
  try {
    const list = await (await fetch(CDP_HTTP('/json/list'), { signal: AbortSignal.timeout(4000) })).json()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 选一个页面。优先 bilibili.com（登录态在它上面），否则第一个 page。
 * @returns 原始 target 或 null
 */
async function pickPage() {
  const pages = (await rawTargets()).filter((t) => t.type === 'page')
  if (pages.length === 0) return null
  return pages.find((t) => String(t.url ?? '').includes('bilibili.com')) ?? pages[0]
}

/** 浏览器没起就起一个，并且等**页面**出现（不是等端口）。 */
async function ensureBrowser() {
  if (await cdpUp()) return { ok: true, started: false }
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BROWSER_PS, '-Action', 'Start',
  ], { encoding: 'utf8', timeout: 60000 })
  if (r.status !== 0) {
    return { ok: false, error: '后台浏览器起不来：' + String(r.stdout ?? '').trim() }
  }
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if ((await rawTargets()).some((t) => t.type === 'page')) return { ok: true, started: true }
    await sleep(200)
  }
  return { ok: false, error: '浏览器起来了但 15 秒内没有页面' }
}

/**
 * 发一条 CDP 指令。一次调用一个 WebSocket，等到 close 再 resolve。
 * @param method - CDP 方法名，如 `Runtime.evaluate`
 * @param params - 方法参数
 * @returns `{ ok, result? , error? }`；永不抛异常
 */
async function cdpSend(method, params = {}) {
  const page = await pickPage()
  if (page === null) return { ok: false, error: 'CDP 里没有 page —— 受控 Edge 需要开着一个页面' }

  return await new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => {
      try { ws.close() } catch { /* 已关 */ }
      done({ ok: false, error: `CDP ${method} 超时 25s` })
    }, 25000)

    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.addEventListener('error', () => { clearTimeout(timer); done({ ok: false, error: 'CDP WebSocket 失败' }) })
    ws.addEventListener('message', (event) => {
      let m
      try { m = JSON.parse(String(event.data)) } catch { return }
      if (m.id !== 1) return // 事件推送没有 id，跳过
      clearTimeout(timer)
      // 必须等 close：提前 resolve 会让 libuv 在退出时断言
      ws.addEventListener('close', () => {
        if (m.error) done({ ok: false, error: 'CDP: ' + JSON.stringify(m.error) })
        else done({ ok: true, result: m.result })
      }, { once: true })
      try { ws.close() } catch { /* 已关 */ }
    })
  })
}

/**
 * 在页面里求值一段表达式，返回它的值。
 * @param expression - 在页面上下文执行的表达式；要返回对象时记得用 `({...})`
 */
async function cdpEval(expression) {
  const r = await cdpSend('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (!r.ok) return r
  if (r.result?.exceptionDetails) {
    return { ok: false, error: '页面内异常: ' + String(r.result.exceptionDetails.text ?? '') }
  }
  return { ok: true, value: r.result?.result?.value }
}

// ── 各个 op ───────────────────────────────────────────────────────────────

async function opPages() {
  const pages = (await rawTargets()).filter((t) => t.type === 'page')
  return { ok: true, count: pages.length, pages: pages.map((t) => ({ id: t.id, title: t.title, url: t.url })) }
}

async function opOpen(url) {
  const nav = await cdpSend('Page.navigate', { url })
  if (!nav.ok) return nav
  if (typeof nav.result?.errorText === 'string' && nav.result.errorText !== '') {
    return { ok: false, error: 'navigate 失败: ' + nav.result.errorText }
  }
  // Page.navigate 返回时文档常常还没提交，必须轮询 readyState
  const deadline = Date.now() + 15000
  let lastState = ''
  while (Date.now() < deadline) {
    const r = await cdpEval('document.readyState')
    if (r.ok) {
      lastState = String(r.value)
      if (lastState === 'complete') break
    }
    await sleep(150)
  }
  const info = await cdpEval('({ url: location.href, title: document.title })')
  if (!info.ok) return info
  const v = info.value ?? {}
  // 15s 没到 complete 就不许报成功 —— 「慢」和「好」是两件事
  if (lastState !== 'complete') {
    return {
      ok: false,
      reason: 'not-complete',
      readyState: lastState || 'unknown',
      url: String(v.url ?? url),
      title: String(v.title ?? ''),
    }
  }
  return { ok: true, url: String(v.url ?? url), title: String(v.title ?? ''), readyState: lastState }
}

async function opRead(maxChars) {
  const r = await cdpEval('document.body ? document.body.innerText : ""')
  if (!r.ok) return r
  const text = String(r.value ?? '')
  if (text.length <= maxChars) {
    return { ok: true, chars: text.length, truncated: 0, text }
  }
  // 丢了多少必须是看得见的数字，不能默默截断
  const dropped = text.length - maxChars
  return {
    ok: true,
    chars: text.length,
    truncated: dropped,
    note: `正文共 ${text.length} 字，按上限只给了前 ${maxChars} 字，丢了 ${dropped} 字`,
    text: text.slice(0, maxChars),
  }
}

async function opClick(selector) {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) return { found: false }
    el.click()
    return { found: true, tag: el.tagName, text: String(el.innerText || el.textContent || '').slice(0, 120) }
  })()`
  const r = await cdpEval(expr)
  if (!r.ok) return r
  const v = r.value ?? {}
  // 找不到就如实说没找到，不许猜别的元素
  if (v.found !== true) return { ok: false, reason: 'no-match', selector }
  return { ok: true, selector, tag: String(v.tag ?? ''), text: String(v.text ?? '') }
}

async function opScroll(px) {
  const r = await cdpEval(`(() => { window.scrollBy(0, ${px}); return window.scrollY })()`)
  if (!r.ok) return r
  return { ok: true, by: px, scrollY: Number(r.value ?? 0) }
}

async function opShot(path) {
  const r = await cdpSend('Page.captureScreenshot', { format: 'png' })
  if (!r.ok) return r
  const b64 = r.result?.data
  if (typeof b64 !== 'string' || b64 === '') return { ok: false, error: 'captureScreenshot 没有返回 data' }
  const buf = Buffer.from(b64, 'base64')
  writeFileSync(path, buf)
  return { ok: true, path, bytes: buf.length }
}

// ── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const op = argv[0]
  if (op === undefined) {
    console.error('用法: node browse.mjs <pages|open|read|click|scroll|shot> [参数]')
    return { ok: false, error: '缺少 op', usage: 'node browse.mjs <pages|open|read|click|scroll|shot> [参数]' }
  }

  const up = await ensureBrowser()
  if (!up.ok) return up

  switch (op) {
    case 'pages':
      return await opPages()

    case 'open': {
      if (argv[1] === undefined) return { ok: false, error: 'open 需要 url' }
      return await opOpen(argv[1])
    }

    case 'read': {
      const n = argv[1] === undefined ? 8000 : Number(argv[1])
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'maxChars 必须是正数' }
      return await opRead(Math.floor(n))
    }

    case 'click': {
      if (argv[1] === undefined) return { ok: false, error: 'click 需要 selector' }
      return await opClick(argv[1])
    }

    case 'scroll': {
      const px = Number(argv[1])
      if (!Number.isFinite(px)) return { ok: false, error: 'scroll 需要数字像素' }
      return await opScroll(px)
    }

    case 'shot': {
      if (argv[1] === undefined) return { ok: false, error: 'shot 需要保存路径' }
      return await opShot(argv[1])
    }

    default:
      return { ok: false, error: '未知 op: ' + op }
  }
}

const result = await main()
if (result.ok !== true && result.error !== undefined) console.error('[browse] ' + result.error)
console.log(JSON.stringify(result))
process.exitCode = result.ok === true ? 0 : 1
