#!/usr/bin/env node
// bili-login.mjs —— 从一个**受控的 Edge 实例**里取出 B站 登录 cookie。
//
// 为什么不用 document.cookie：B站 的 SESSDATA 是 **HttpOnly**，页面脚本读不到。
// 必须走 CDP 的 `Storage.getCookies`（浏览器级命令），它返回的是解密后的明文。
//
// 为什么不用你日常那个浏览器：红线三「采集默认全关，要哪项显式开」。
// 这里读的是**一个专用 profile**——你自己在里面登录，读完可以关掉。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node bili-login.mjs status             只看登录了没有（不打印 cookie）
//   node bili-login.mjs cookie            打印 `SESSDATA=...; bili_jct=...` 形式，供 curl/环境变量用
//   node bili-login.mjs cookie --json     打印 JSON，给别的程序读
//   node bili-login.mjs whoami            调 B站 导航接口，确认登录态真实有效
//
// 端口默认 9223（避开项目里 9222 那个常用端口）。

const PORT = Number(process.env.BILI_CDP_PORT ?? 9224)
const HOST = '127.0.0.1'

/** 需要带上的 B站 cookie 名字；SESSDATA 是主凭据，bili_jct 是 CSRF。 */
const WANTED = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

/**
 * 连 CDP 浏览器级 WebSocket，发一条命令，拿结果。
 * Node 22+ 自带全局 WebSocket，不装依赖。
 * @param method - CDP 方法名
 * @param params - 命令参数
 * @returns 命令结果对象
 */
async function cdp(method, params = {}) {
  const version = await fetch(`http://${HOST}:${PORT}/json/version`, { signal: AbortSignal.timeout(5000) })
  if (!version.ok) throw new Error(`CDP /json/version → HTTP ${version.status}`)
  const info = await version.json()
  const wsUrl = info.webSocketDebuggerUrl
  if (typeof wsUrl !== 'string') throw new Error('拿不到 webSocketDebuggerUrl')

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { try { ws.close() } catch { /* 已经关了 */ } ; reject(new Error('CDP 超时 15s')) }, 15000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')) })
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== 1) return
      clearTimeout(timer)
      // ★ 必须**等到 close 事件真的发生**再 resolve。
      // 否则调用方 process.exit 时 ws 还在关闭中，libuv 会断言失败
      // （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`），
      // 结果是**输出全对但退出码是 -1073740791** —— 又一个"成功长得像失败"。
      ws.addEventListener('close', () => {
        if (msg.error) reject(new Error(`CDP ${method} 失败: ${msg.error.message}`))
        else resolve(msg.result)
      }, { once: true })
      ws.close()
    })
  })
}

/**
 * 取当前受控实例里所有 .bilibili.com 的 cookie。
 * @returns `{ ok, cookies, detail }`；ok=false 时 detail 说明为什么
 */
export async function readCookies() {
  let result
  try {
    result = await cdp('Storage.getCookies')
  } catch (error) {
    return { ok: false, cookies: [], detail: String(error?.message ?? error) }
  }
  const all = Array.isArray(result?.cookies) ? result.cookies : []
  const bili = all.filter((c) => String(c?.domain ?? '').includes('bilibili.com'))
  return { ok: true, cookies: bili, detail: `共 ${all.length} 个 cookie，其中 bilibili ${bili.length} 个` }
}

/**
 * 把 cookie 数组拼成请求头形式。
 * @param cookies - CDP 返回的 cookie 对象数组
 * @returns `name=value; name=value`，只保留 WANTED 里那几项
 */
export function toHeader(cookies) {
  return cookies
    .filter((c) => WANTED.includes(String(c?.name ?? '')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const [cmd, ...flags] = process.argv.slice(2)

if (cmd === 'status') {
  const r = await readCookies()
  if (!r.ok) { console.log(JSON.stringify({ ok: false, detail: r.detail }, null, 2)); process.exit(2) }
  const names = r.cookies.map((c) => String(c.name))
  const has = WANTED.filter((n) => names.includes(n))
  console.log(JSON.stringify({
    ok: has.includes('SESSDATA'),
    loggedIn: has.includes('SESSDATA'),
    detail: r.detail,
    have: has,
    missing: WANTED.filter((n) => !names.includes(n)),
  }, null, 2))
  process.exitCode = has.includes('SESSDATA') ? 0 : 1
} else if (cmd === 'cookie') {
  const r = await readCookies()
  if (!r.ok) { console.error(r.detail); process.exit(2) }
  const header = toHeader(r.cookies)
  if (header === '') { console.error('没有 SESSDATA —— 那个 Edge 实例里还没登录 B站'); process.exit(1) }
  if (flags.includes('--json')) console.log(JSON.stringify({ header }))
  else console.log(header)
} else if (cmd === 'whoami') {
  const r = await readCookies()
  if (!r.ok) { console.error(r.detail); process.exit(2) }
  const header = toHeader(r.cookies)
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120', Referer: 'https://www.bilibili.com/', Cookie: header },
    signal: AbortSignal.timeout(15000),
  })
  const j = await res.json()
  const ok = j?.data?.isLogin === true
  console.log(JSON.stringify({ ok, code: j?.code, uname: j?.data?.uname ?? null, mid: j?.data?.mid ?? null }, null, 2))
  process.exitCode = ok ? 0 : 1
} else {
  console.error('子命令: status | cookie [--json] | whoami')
  process.exitCode = 64
}
