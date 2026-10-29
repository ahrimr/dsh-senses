import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

// senses 的 DSH 插件入口 —— 挂载方式是**一条 Host 行**，声明在 `senses/bundle/cordis.patch.yml`：
//
//   - insert:
//       - id: senses
//         name: '@local/dsh-senses'                       # bundle 包名，走运行时解析
//         config: { root: 'D:\...\gongzuo\senses' }
//
// **Host 级注册的工具进 `tools` 的全局层，每个 agent preset 的 Agent 都继承得到**
// （除非显式 `tools.restrict` 收窄）。所以不再需要"每个模式拷一份预设"。
//
// 44.7.0 把旧的挂载路径整个作废了：`$DSH_HOME/.agent-presets/<id>/`（preset.yml +
// agent.cordis.yml）**已经没有任何组件读**；官方预设改成 `@deepseek-ai/dsh-agent-preset`
// 的声明行。原先那种「拷整份官方 composition + 末尾加一行绝对路径」的做法，
// 既不被读，也会在升级时腐烂。
//
// ── 为什么这个文件一个 import 都没有 ─────────────────────────────────────────
//
// 这个文件内部 `import '@deepseek-ai/dsh-tools'` 会由 Node 从**本文件的位置**向上找
// node_modules —— 实测 ERR_MODULE_NOT_FOUND，因为 senses 住在 `gongzuo/` 下，走不到
// harness 的依赖树。
//
// 所以这里不 import 任何东西，而是**照着 defineTool 的输出形状手搓工具定义**：
//   { name, description, parameters(裸 JSON Schema), output: { schema, render }, execute }
//
// 代价要说清楚：这依赖 harness 内部形状。44.7.0 实测这个形状**没变**
// （线上工具 schema 的 `parameters` 就是裸 JSON Schema），但同一版里 `shell` 的契约变了
// （`run(spec)` → `execute(spec)` + 句柄 `.result()`）—— 断点从哪里来，事先猜不准。
// 所以真正的护栏不是这段注释，而是**装完立刻真调一次工具的验收**。
// （另一条路是 import 真包，但那要求这个文件住进 harness 树里 —— 那就不是"可插可拔的 senses"了。）

export const name = 'senses'

/** 硬依赖：`tools` 用来注册工具，`shell` 用来跑 senses 自己的脚本。 */
export const inject = ['tools', 'shell']

/**
 * 把 senses 的能力注册成模型可调用的工具。
 *
 * @param ctx - 这个 preset 作用域下的 Cordis 上下文。
 * @param config - 来自 composition row 的配置；`root` 是 senses 插件目录的绝对路径。
 */
export function apply(ctx, config) {
  // `root` 可以显式配（老用法），也可以不配 —— 不配就取**本文件所在包根目录**。
  // 为什么必须能自推：发布成 npm 包之后别人的安装路径跟这里完全不同；
  // 写死一个绝对路径，装到别人机器上就找不到 adapters/。
  const root = (config && typeof config.root === 'string' && config.root !== '')
    ? config.root
    : dirname(dirname(fileURLToPath(import.meta.url)))

  const script = root + '\\adapters\\media.ps1'

  ctx.tools.register({
    name: 'senses_media',
    description:
      '读这台电脑现在正在播放的媒体（只读，约 0.6 秒）。回答：有没有东西在播 / 是哪个程序 / '
      + '在播什么 / 播到第几秒 / 是播是停 / 是不是直播。不改变任何东西，不需要事先起任何服务。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute() {
      return runMedia(' -Now')
    },
  })

  /**
   * 跑一次 media.ps1，把**退出码和原始输出一起**交回。
   *
   * 退出码是判据的一部分，不能吞：2=NOMATCH 3=发出了但状态没变（静默失败）4=拒绝执行
   * （目标不明确 / 停手）5=这件事在这个目标上不适用 6=已停手。模型必须看得到它。
   *
   * @param extraArgs - 直接拼在脚本路径后面的参数串，以空格开头。
   * @returns 形如 `exit=N\n<原始输出>` 的一段文本。
   */
  async function runMedia(extraArgs) {
    const spec = ctx.shell.resolve({
      command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + script + '"' + extraArgs,
      workdir: root,
      timeoutMs: 30000,
      stdoutMaxBytes: 65536,
      // **必须显式给 sandboxPolicy。** Host 级插件没有会话，`pwsh-sandbox` 在
      // `request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()` 里会取默认策略，
      // 而默认是 read-only —— 写入被拒，media.ps1 连记忆和面板账本都写不进去。
      // 旧的位置（preset 里）继承的是会话策略，所以以前不会踩。
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: root },
    })
    // 44.7.0 起 `shell` 的契约是 resolve(request) → execute(spec) → 句柄 → result()；
    // 旧的 `run(spec)` 已经不存在了（这正是本次升级打断的第一处）。
    const handle = await ctx.shell.execute(spec)
    const result = await handle.result()
    const raw = result.stdout
    const text = typeof raw === 'string'
      ? raw
      : (raw && typeof raw.text === 'string' ? raw.text : '')
    return 'exit=' + String(result.exitCode) + '\n' + text.trim()
  }

  /**
   * 把用户/模型给的标题片段变成能安全拼进命令行的形式。
   *
   * 命令行是**字符串拼接**的，所以这里 fail-closed：只要含可能改变命令含义的字符就拒绝，
   * 并告诉模型换一个更简单的片段。宁可不动，也不能拼出一条自己没预期的命令。
   *
   * @param title - 目标标题片段。
   * @returns 可以拼接的片段，或 `null` 表示拒绝。
   */
  function safeTitle(title) {
    if (typeof title !== 'string' || title === '') return null
    if (/["'`$\\;|&<>(){}[\]\r\n]/.test(title)) return null
    return title
  }

  ctx.tools.register({
    name: 'senses_media_control',
    description:
      '【写操作 —— 会改变用户正在看的东西】暂停 / 继续 / 拖进度条 / 下一集 / 上一集。'
      + '**只在用户明确要求时才调用，不要自作主张。**'
      + '不做猜测：同时在播多个又没给 title 时一律拒绝（exit 4）；用户按了面板「停手」时直接拒绝（exit 6）。'
      + '动作发出后会**复核真实状态**，没变就报 exit 3（实测有的写操作返回成功却什么都没做）。'
      + '不支持改播放速率（浏览器不暴露这个能力）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pause', 'play', 'toggle', 'seek', 'next', 'prev'],
          description: 'pause=暂停 play=继续 toggle=切换 seek=拖进度条 next/prev=上下一集',
        },
        to: { type: 'number', description: 'seek 专用：目标秒数（从 0 开始）。其它动作不要传。' },
        title: { type: 'string', description: '可选。只在标题含这个片段时才动它 —— 同时有多个在播时用它精确指定目标。' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args) {
      const a = args && typeof args === 'object' ? args : {}
      const action = a.action
      if (typeof action !== 'string' || action === '') {
        return '没有给出 action。可选：pause / play / toggle / seek / next / prev。'
      }
      if (action === 'seek' && typeof a.to !== 'number') {
        // 提前挡住，不把 `-To -1` 递给脚本：那会变成一次"看起来做了但其实没意义"的调用。
        return 'seek 必须同时给出 to（目标秒数）。例如 action=seek, to=600。'
      }
      let extra = ' -Control ' + action
      if (action === 'seek') extra += ' -To ' + String(a.to)
      if (a.title !== undefined && a.title !== '') {
        const t = safeTitle(a.title)
        if (t === null) {
          return 'title 里有会改变命令含义的字符（引号、$、反引号、分号、竖线等），已拒绝执行。'
            + '请换一个更简单的片段，比如节目标题里的一小段文字。'
        }
        extra += ' -Match "' + t + '"'
      }
      return runMedia(extra)
    },
  })

  // 注意：这里必须是双反斜杠。JS 字符串里 `'\a'` 是非法转义、会退化成 `'a'`，
  // 单反斜杠会让路径变成 `sensesadapterswatch.mjs`；而报错只说"找不到模块"，
  // 从错误信息完全看不出是路径被吃掉了一段。这个坑连踩两处（watch / browse）。
  const watchScript = root + '\\adapters\\watch.mjs'

  ctx.tools.register({
    name: 'senses_watch',
    description:
      '读 B站点播视频在某个时间段的**字幕原文**（只读）。典型用途：陪用户一起看视频时，回答「刚才讲了什么 / 这一段在说什么」。'
      + '**必须给 policy，没有默认值** —— 因为默认全片会在陪看时剧透，默认 [0,t] 又会在速览时缺内容，两个都错。'
      + 'policy=current_prefix 只给 t 之前的内容，而且**跨过 t 的那一条会整条丢掉**（不按比例截断，那会泄露后半句）。'
      + '不做猜测：多分P 没给 cid 就拒绝；没拿到就返回 not_observed / browser_unavailable，**绝不写「这个视频没有字幕」**。'
      + '浏览器按需自己起、用完自己关，不需要事先准备任何东西。'
      + '返回里带覆盖率与缺口，覆盖率不等于「内容完整」也不等于「正确」。'
      // ↓ 这一段是给"接上来的那个 agent"的用法约束。性格与人设不归这里管（那是它的身份卡），
      //   这里只保证它知道手里拿的是**素材**，并顺手提醒别原样吐出去。
      + '\n\n**返回的是【字幕原素材】，不是给你念的台词。**必须：'
      + '① 用你自己的话转述，按你现在的身份和语气说出来；'
      + '② 不要照抄原文、不要用"字幕列表"的形式复述；'
      + '③ t 之后的内容一律不存在（工具里没有），不得推测、不得补写。'
      + '你拿到的是"他刚才看的那一段说了什么"，不是"一份需要朗读的稿子"。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: '视频 BV 号，形如 BV1xxxxxxxxx。**与 title 二选一**' },
        title: {
          type: 'string',
          description: '视频标题（就是 `senses_media` 返回的那个）。给了它就**不必给 bvid** —— 会拿标题去 B站 搜；'
            + '**只有某条搜索结果与标题完全一致才用**，否则把候选列回来让人确认，绝不猜',
        },
        policy: {
          type: 'string',
          enum: ['current_prefix', 'window', 'full'],
          description: '必需。current_prefix=陪看（只给 t 之前）；window=指定一段；full=全片（不用于陪看）' },
        t: { type: 'number', description: 'policy=current_prefix 时必需：当前播到第几秒' },
        start: { type: 'number', description: 'policy=window 时必需：起始秒' },
        end: { type: 'number', description: 'policy=window 时必需：结束秒' },
        back: { type: 'number', description: '可选：current_prefix 回看多少秒，默认 180。给太长会把上下文撑爆' },
        cid: { type: 'number', description: '可选：多分P 视频必须指定，否则拒绝（不替调用方猜第几P）' },
      },
      required: ['policy'],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args) {
      const a = args && typeof args === 'object' ? args : {}
      if (a.policy !== 'current_prefix' && a.policy !== 'window' && a.policy !== 'full') {
        return 'policy 必填，且只能是 current_prefix / window / full。没有默认值 —— 默认哪个都会在某种用法下出错。'
      }
      const hasBvid = typeof a.bvid === 'string' && a.bvid !== ''
      const hasTitle = typeof a.title === 'string' && a.title !== ''
      if (!hasBvid && !hasTitle) return '缺少 bvid 和 title —— 两者至少给一个。不知道 BV 号时传 senses_media 给的那个标题即可。'

      // 命令行是字符串拼接，两个入口都要 fail-closed。
      let head
      if (hasBvid) {
        if (!/^[A-Za-z0-9]+$/.test(a.bvid)) return 'bvid 只允许字母数字（BV 号），已拒绝拼接。'
        head = a.bvid
      } else {
        if (a.title.length > 300) return 'title 太长（>300 字），已拒绝。'
        // 标题走 base64url：B站 标题里常有 【】|() 之类，直接拼命令行会被 shell 解释。
        // base64url 只有字母数字和 -_，任何字符都伤不到命令行。
        head = '--title-b64 ' + Buffer.from(a.title, 'utf8').toString('base64url')
      }
      const parts = ['--policy', a.policy]
      if (typeof a.t === 'number') parts.push('--t', String(a.t))
      if (typeof a.start === 'number') parts.push('--start', String(a.start))
      if (typeof a.end === 'number') parts.push('--end', String(a.end))
      if (typeof a.back === 'number') parts.push('--back', String(a.back))
      if (typeof a.cid === 'number') parts.push('--cid', String(a.cid))
      const spec = ctx.shell.resolve({
        command: 'node "' + watchScript + '" ' + head + ' ' + parts.join(' '),
        workdir: root,
        timeoutMs: 90000,
        stdoutMaxBytes: 262144,
        // 同上：不显式给，就落到默认的 read-only，起浏览器和写取证文件都会失败。
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: root },
      })
      // 同 runMedia：execute(spec) 拿句柄，再 result() 拿退出码和输出。
      const handle = await ctx.shell.execute(spec)
      const result = await handle.result()
      const pick = (v) => (typeof v === 'string' ? v : (v && typeof v.text === 'string' ? v.text : ''))
      // stderr 也要交回去：之前只读 stdout，导致失败时只有一句 "exit=1"、原因全丢。
      // 规矩是「丢了多少必须是模型看得见的数字」，错误信息同理。
      const err = pick(result.stderr).trim()
      return 'exit=' + String(result.exitCode)
        + (err === '' ? '' : '\n[stderr]\n' + err)
        + '\n' + pick(result.stdout).trim()
    },
  })

  // ── senses_browse：在受控 Edge 上做通用网页操作 ──────────────────────────────
  //
  // 为什么做成「一个工具带 op」而不是六个工具：这组动作共用同一台浏览器、同一套闸门，
  // 拆成六个只会让工具表更长，而参数几乎一样。
  //
  // 为什么只用 9224 这台受控 Edge：它有自己的 profile，不碰用户前台正在用的浏览器。
  // 那条红线（不抢用户的前台）在这里是靠「物理隔离」兑现的，不是靠自觉。
  // 同 watchScript：双反斜杠，单的会被 JS 当成非法转义吃掉。
  const browseScript = root + '\\adapters\\browse.mjs'

  /** URL 白名单：只收 http(s)，且不许含能改变命令行含义的字符。 */
  function safeUrl(url) {
    if (typeof url !== 'string' || url === '' || url.length > 2000) return null
    if (/["`$\\\r\n]/.test(url)) return null
    if (!/^https?:\/\/[^\s]+$/.test(url)) return null
    return url
  }

  /** 选择器：双引号/反引号/$/反斜杠/换行一律拒 —— 命令是字符串拼接出来的。 */
  function safeSelector(sel) {
    if (typeof sel !== 'string' || sel === '' || sel.length > 200) return null
    if (/["`$\\\r\n]/.test(sel)) return null
    return sel
  }

  /** 取整并夹到区间；不是数值就返回 null（不猜默认值）。 */
  function clampInt(v, lo, hi) {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return null
    return Math.min(hi, Math.max(lo, n))
  }

  ctx.tools.register({
    name: 'senses_browse',
    description:
      '在**受控浏览器**（本机 9224 的 Edge，已登录 B站，和用户前台浏览器完全隔离）上操作网页。'
      + 'op=pages 列页面 / open 导航 / read 取正文 / click 点元素 / scroll 滚动 / shot 截图存盘（返回路径，再用 read_image 看）。'
      + '**只碰这台受控 Edge，绝不驱动用户前台正在用的浏览器。**'
      + '不做猜测：click 找不到选择器就返回 no-match，不会改点别的元素；read 超过上限会明说丢了多少字。'
      + '已知边界：CLI 无状态，每次调用一个连接 —— 多标签页时「刚才 open 的那一页」不保证，单页场景没问题。'
      + '浏览器没起会自己起，用完不关（下次复用，省掉冷启动）。',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['pages', 'open', 'read', 'click', 'scroll', 'shot'],
          description: '要做的动作',
        },
        url: { type: 'string', description: 'op=open 时必需：完整 http(s) 地址' },
        selector: { type: 'string', description: 'op=click 时必需：CSS 选择器，例如 a[href*="video"]' },
        px: { type: 'number', description: 'op=scroll 时用：正数往下、负数往上，范围 ±5000' },
        maxChars: { type: 'number', description: 'op=read 时用：最多取多少字，默认 8000，范围 100–8000' },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args) {
      const a = args && typeof args === 'object' ? args : {}
      const op = a.op
      if (!['pages', 'open', 'read', 'click', 'scroll', 'shot'].includes(op)) {
        return 'op 必须是 pages / open / read / click / scroll / shot 之一。'
      }
      const parts = ['"' + browseScript + '"', op]
      if (op === 'open') {
        const url = safeUrl(a.url)
        if (url === null) return 'open 需要一个合法的 http(s) 地址，已拒绝拼接。'
        parts.push('"' + url + '"')
      } else if (op === 'click') {
        const sel = safeSelector(a.selector)
        if (sel === null) return 'click 需要一个合法的 CSS 选择器（不含双引号/反引号/$/反斜杠/换行），已拒绝拼接。'
        parts.push('"' + sel + '"')
      } else if (op === 'scroll') {
        const px = clampInt(a.px, -5000, 5000)
        if (px === null) return 'scroll 需要一个数值 px（±5000 内）。'
        parts.push(String(px))
      } else if (op === 'read') {
        const n = a.maxChars === undefined ? 8000 : clampInt(a.maxChars, 100, 8000)
        if (n === null) return 'maxChars 必须是 100–8000 的数值。'
        parts.push(String(n))
      } else if (op === 'shot') {
        // 截图路径由插件决定，不让调用方给 —— 少一个能被拼接的入口。
        // 落到 work\watch（这个目录本来就存在，不用先建）。
        parts.push('"' + root + '\\work\\watch\\shot-' + Date.now() + '.png"')
      }
      const spec = ctx.shell.resolve({
        command: 'node ' + parts.join(' '),
        workdir: root,
        timeoutMs: 60000,
        stdoutMaxBytes: 262144,
        // 同 senses_watch：不显式给就落到默认 read-only，起浏览器会失败。
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: root },
      })
      const handle = await ctx.shell.execute(spec)
      const result = await handle.result()
      const pick = (v) => (typeof v === 'string' ? v : (v && typeof v.text === 'string' ? v.text : ''))
      const err = pick(result.stderr).trim()
      return 'exit=' + String(result.exitCode)
        + (err === '' ? '' : '\n[stderr]\n' + err)
        + '\n' + pick(result.stdout).trim()
    },
  })
}