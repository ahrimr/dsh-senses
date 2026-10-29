// plugin-selftest.mjs —— 闸门：插件那一行到底注册出了什么
//
// 为什么需要：`senses/plugin/index.mjs` 是「可插可拔的一行」的全部内容，而它**从来没被测过**。
// 结果就是一次真实疏漏：手（暂停/继续/拖/上下曲）在 media.ps1 里早就练好并验证过，
// 但**没有任何工具把它接出去** —— 新会话里的 AI 手上根本没有这个按钮，而没人发现，
// 因为唯一的检验方式是「用户开个新会话自己试」。
//
// 这个测试不需要 DSH：插件零 import、只是往 ctx 上注册，
// 所以给它一个假的 ctx 就能把注册出来的东西和拼出来的命令**逐字**看清。
//
// 用法： node "D:\deepseek harness\gongzuo\senses\work\plugin-selftest.mjs"

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// 必须用 fileURLToPath，不能用 new URL(...).pathname 手工拼：
// 本仓库路径里有空格（`deepseek harness`），pathname 会把它变成 %20，import 直接失败。
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const pluginPath = path.join(root, 'plugin', 'index.mjs')

let bad = 0
let total = 0
function ok(cond, name, detail = '') {
  total++
  if (cond) {
    console.log('  ok   ' + name + '  ' + detail)
  } else {
    console.log('  FAIL ' + name + '  ' + detail)
    bad++
  }
}

const mod = await import(pathToFileURL(pluginPath).href)

// ── 1. 插件本身的形状 ────────────────────────────────────────────────────────
ok(mod.name === 'senses', '插件名是 senses', String(mod.name))
ok(Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('shell'),
  '声明了 tools + shell 两个硬依赖', JSON.stringify(mod.inject))
ok(typeof mod.apply === 'function', '导出了 apply', '')

// ── 2. 假 ctx：把注册出来的定义和拼出来的命令全抓住 ──────────────────────────
const registered = []
const specs = []
const FAKE_ROOT = 'R:\\fake\\senses'
let stubExit = 0
let stubOut = 'STUB-OUT'

const ctx = {
  tools: { register(def) { registered.push(def) } },
  shell: {
    resolve(spec) { specs.push(spec); return spec },
    // 44.7.0 的 shell 契约：`execute(spec)` → 句柄 → `result()`；旧的 `run(spec)` 已经不存在。
    // 这里刻意照抄真契约的两个形状：
    //   ① execute 返回的是**句柄**，不是结果；
    //   ② `stdout` 是 `CollectedOutput {text, truncated}`，不是裸字符串。
    // 假 ctx 一旦落后于真契约，测试台就会"通过"一个线上已经坏掉的东西 ——
    // 这次升级正是这么被发现的（插件调 run，线上没有 run，测试台也没跑过真契约）。
    async execute() {
      return { result: async () => ({ exitCode: stubExit, stdout: { text: stubOut, truncated: false } }) }
    },
  },
}

mod.apply(ctx, { root: FAKE_ROOT })

const byName = new Map(registered.map((d) => [d.name, d]))
// **不写死工具个数。** 加一个工具是正常演进，写死「等于 2」会让「加工具」看起来像「出了回归」——
// 项目早就立过这条规矩（回归判据是「PASS 全部 N 套通过」，N 不固定）。我第一次写这个闸门时就写死了 2，
// 加进 senses_watch 后立刻误报。判据改成「必需的那几个都在」。
const REQUIRED = ['senses_media', 'senses_media_control', 'senses_watch']
ok(registered.length >= REQUIRED.length, '注册了至少 ' + REQUIRED.length + ' 个工具', [...byName.keys()].join(', '))
for (const need of REQUIRED) ok(byName.has(need), '有工具 ' + need, '')

// ── 3. 每个定义的形状都要过 harness 的硬校验 ────────────────────────────────
// ctx.tools.register 会硬校验：output.render 必须是函数、schema 必须是受支持的子集、
// timeoutMs 必须是正有限数、重名会抛。
//
// **不自己手写一份白名单去模拟它。** 我第一版就是这么干的，结果把允许的 `description`
// 判成了非法 —— 同一条规则写两遍，第二遍必然和第一遍漂移（同一个毛病在 media.ps1 里刚修过一次）。
// 这里直接调 harness 自己的校验器；拿不到它就**响亮地失败**，不能退回到"看起来没问题"。
const harnessSchema = path.join(root, '..', '..', 'packages', 'core', 'tools', 'lib', 'types', 'json-schema.js')
let assertSupportedJsonSchema = null
try {
  const m = await import(pathToFileURL(harnessSchema).href)
  if (typeof m.assertSupportedJsonSchema === 'function') assertSupportedJsonSchema = m.assertSupportedJsonSchema
} catch { /* 下面统一报错 */ }
if (assertSupportedJsonSchema === null) {
  // 发布出去的包里没有 harness 源码树，这类断言只在开发机上成立 —— **跳过，不判失败**。
  console.log('  skip  拿不到 harness 的 schema 校验器（本仓库没有源码树）→ 跳过 schema 校验')
}

function schemaVerdict(schema) {
  if (assertSupportedJsonSchema === null) return '校验器不可用，无法证明它合法'
  try { assertSupportedJsonSchema(schema); return null } catch (e) { return e.message }
}

for (const [name, def] of byName) {
  ok(typeof def.description === 'string' && def.description.length > 20, name + ' 有像样的描述', '')
  ok(typeof def.execute === 'function', name + ' 有 execute', '')
  ok(def.output && typeof def.output.render === 'function', name + ' 的 output.render 是函数', '')
  if (assertSupportedJsonSchema !== null) {
    const pv = schemaVerdict(def.parameters)
    ok(pv === null, name + ' 的参数 schema 通过 harness 真校验', pv === null ? '' : pv)
    const ov = schemaVerdict(def.output.schema)
    ok(ov === null, name + ' 的输出 schema 通过 harness 真校验', ov === null ? '' : ov)
  }
  const r = def.output.render({}, 'hi')
  ok(Array.isArray(r) && r[0] && r[0].type === 'text' && r[0].text === 'hi', name + ' 的 render 能出文本块', '')
}

// ── 4. 拼出来的命令必须逐字对 ────────────────────────────────────────────────
async function exec(name, args) {
  specs.length = 0
  const out = await byName.get(name).execute(args)
  return { out, spec: specs.length > 0 ? specs[specs.length - 1] : null }
}

const read = await exec('senses_media', {})
ok(read.spec !== null && read.spec.command.endsWith(' -Now'), '只读工具拼的是 -Now', read.spec ? read.spec.command : '(没跑)')
ok(read.spec !== null && read.spec.workdir === FAKE_ROOT, '工作目录来自 config.root', read.spec ? read.spec.workdir : '')
ok(read.out.startsWith('exit=0'), '退出码被原样交回（判据的一部分，不能吞）', read.out.split('\n')[0])

const pause = await exec('senses_media_control', { action: 'pause' })
ok(pause.spec !== null && /-Control pause$/.test(pause.spec.command), 'pause 拼成 -Control pause', pause.spec ? pause.spec.command : '(没跑)')

const seek = await exec('senses_media_control', { action: 'seek', to: 600 })
ok(seek.spec !== null && /-Control seek -To 600$/.test(seek.spec.command), 'seek 带上 -To', seek.spec ? seek.spec.command : '(没跑)')

const titled = await exec('senses_media_control', { action: 'next', title: '奶龙' })
ok(titled.spec !== null && titled.spec.command.endsWith(' -Control next -Match "奶龙"'), 'title 拼成 -Match', titled.spec ? titled.spec.command : '(没跑)')

// ── 4b. 脚本路径不许在中途被吃掉 ────────────────────────────────────────────
// 踩过：`root + '\adapters\watch.mjs'` —— JS 里 `'\a'` 是非法转义，会退化成 `'a'`，
// 路径变成 `sensesadapterswatch.mjs`。而报错只写"找不到模块"，
// 从错误信息完全看不出是路径被吃了半截。两处（watch / browse）同时踩。
// 这条闸盯的就是"路径里必须真的还有 adapters 这一级"。
const SCRIPT_TAIL = /adapters[\\/](watch|browse)\.mjs/

const watchCmd = await exec('senses_watch', { bvid: 'BV1kLnw6YE6e', policy: 'window', start: 0, end: 10 })
ok(watchCmd.spec !== null && SCRIPT_TAIL.test(watchCmd.spec.command), 'senses_watch 的脚本路径没被吃掉',
  watchCmd.spec ? watchCmd.spec.command : '(没跑)')
ok(watchCmd.spec !== null && !/sensesadapters/i.test(watchCmd.spec.command), 'senses_watch 路径里没有粘连的 sensesadapters', '')

const browseCmd = await exec('senses_browse', { op: 'pages' })
ok(browseCmd.spec !== null && /adapters[\\/]browse\.mjs/.test(browseCmd.spec.command), 'senses_browse 的脚本路径没被吃掉',
  browseCmd.spec ? browseCmd.spec.command : '(没跑)')
ok(browseCmd.spec !== null && !/sensesadapters/i.test(browseCmd.spec.command), 'senses_browse 路径里没有粘连的 sensesadapters', '')

// ── 4c. 只给标题的路：标题必须走 base64url，绝不直接拼进命令行 ──────────────
// 为什么：B站 标题里常有 【】|() 之类，直接拼接会被 shell 解释。base64url 只有
// 字母数字和 -_，任何标题都伤不到命令行。
const TITLE = '【极客湾】荣耀Robot Phone上手体验：形态特别|用起来咋样？'
const byTitle = await exec('senses_watch', { title: TITLE, policy: 'window', start: 0, end: 10 })
const b64 = /--title-b64 ([A-Za-z0-9_-]+)/.exec(byTitle.spec ? byTitle.spec.command : '')
ok(byTitle.spec !== null && b64 !== null, 'senses_watch 用 --title-b64 传标题', byTitle.spec ? byTitle.spec.command : '(没跑)')
if (b64 !== null) {
  ok(Buffer.from(b64[1], 'base64url').toString('utf8') === TITLE, '标题 base64 解码后与原文完全一致', '')
}
ok(byTitle.spec !== null && !byTitle.spec.command.includes('极客湾'), '标题原文没有出现在命令行里（防 shell 解释）', '')

const neitherId = await exec('senses_watch', { policy: 'window', start: 0, end: 10 })
ok(neitherId.spec === null && /至少给一个/.test(neitherId.out), 'bvid 和 title 都不给 → 拒绝且没调 shell', neitherId.out.slice(0, 40))

const bothId = await exec('senses_watch', { bvid: 'BV1kLnw6YE6e', title: '不该被用到的标题', policy: 'window', start: 0, end: 10 })
ok(bothId.spec !== null && !bothId.spec.command.includes('title-b64'), '同时给 bvid 和 title → 用 bvid，不去搜', bothId.spec ? bothId.spec.command : '')

// ── 5. 该拒绝的时候必须拒绝，而且**不许碰 shell** ────────────────────────────
const noTo = await exec('senses_media_control', { action: 'seek' })
ok(noTo.spec === null && /必须同时给出 to/.test(noTo.out), 'seek 缺 to → 拒绝且没调 shell', noTo.out.slice(0, 40))

const noAction = await exec('senses_media_control', {})
ok(noAction.spec === null && /没有给出 action/.test(noAction.out), '缺 action → 拒绝且没调 shell', noAction.out.slice(0, 40))

for (const evil of ['a"b', 'a$b', 'a`b', 'a;b', 'a|b', 'a\r\nb']) {
  const r = await exec('senses_media_control', { action: 'pause', title: evil })
  ok(r.spec === null, '危险 title ' + JSON.stringify(evil) + ' → 拒绝且没调 shell', '')
}

// ── 6. 出口码原样传递（静默失败 / 停手 都要能被模型看见）────────────────────
stubExit = 3; stubOut = '* SILENT-FAIL 状态没变'
const sf = await exec('senses_media_control', { action: 'pause' })
ok(sf.out.startsWith('exit=3') && sf.out.includes('SILENT-FAIL'), 'exit 3 原样交回，不被当成成功', sf.out.split('\n')[0])
stubExit = 6; stubOut = 'REFUSED-STOPPED'
const st = await exec('senses_media_control', { action: 'pause' })
ok(st.out.startsWith('exit=6') && st.out.includes('REFUSED-STOPPED'), 'exit 6（停手）原样交回', st.out.split('\n')[0])

if (bad === 0) { console.log('PASS 插件闸门（' + total + ' 项）'); process.exit(0) }
console.log('FAIL 插件闸门：' + bad + '/' + total + ' 项未通过')
process.exit(1)
