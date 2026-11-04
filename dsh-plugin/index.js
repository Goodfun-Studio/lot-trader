/**
 * `@goodfun-studio/dsh-lot-trader` —— lot-trader 操盘引擎在 DSH 上的原生壳（Cordis 插件形态）。
 *
 * 这一层做四件事，全部是**机会式接线**（邻居在就接、不在就等，因此 row 顺序对它没有语义）：
 *
 * 1. 把 `trade` CLI 注册成模型端工具（`ctx.tools`）——见 `./tools.js`；
 * 2. 给改账本的工具挂一道审批闸门（`tools/pre-execute` 返回 `ask`）：
 *    读命令自由跑，买入/加仓/平仓/记分红/建账户必须先过用户这一关；
 * 3. 把操盘纪律注入 systemPrompt（`ctx.systemPrompt.section`），
 *    让「30% 硬顶、48h 防抖、严禁深跌冻结、账户强隔离」每轮都在场，
 *    而不是躺在某个 skill 文档里等着被翻到；
 * 4. 在看板侧起一份只读快照（`ctx.webServer` 回环路由 + `ctx.timer` 后台刷新），
 *    交给同源的 Client 面板渲染。
 *
 * 引擎本身一行没动：所有账本语义仍住在编译好的 `trade` 二进制里，
 * 这里只负责「把它的契约原样端到模型和用户眼前」。
 *
 * @module @goodfun-studio/dsh-lot-trader
 */

import {
  deriveBoard,
  downloadBinary,
  normalizeConfig,
  createCliRunner,
  createTradeTools,
  platformTarget,
  resolveBinary,
  resolveDbPath,
  TOOL_NAMES,
  WRITE_TOOLS,
} from './tools.js'

/** 看板只读快照路由（GET）。 */
export const SNAPSHOT_PATH = '/api/lot-trader/snapshot'
/** 强制立即重算一次快照的路由（POST）。 */
export const REFRESH_PATH = '/api/lot-trader/refresh'
/** 侧边栏图标 id 与 main 面板 key 必须是同一个值，owner 靠它配对。 */
export const PANEL_ID = 'lot-trader'
/** 操盘纪律切片在 systemPrompt 里的 section 名（同 scope 重名注册会抛错）。 */
export const DISCIPLINE_SECTION = 'lot-trader-discipline'

/** 活跃批次上限之外不再内联进快照，防止单次响应无限膨胀。 */
const MAX_INLINE_LOTS = 500

/**
 * 自动下载的总时长上限。
 *
 * 取 45 分钟是有意的宽松：README 记录过实测 95KB/s，85MB 约需 15 分钟，
 * 留三倍余量给更慢的链路。它只兜「一直有零星数据但永远传不完」的病态情形；
 * 「完全停滞」由 downloadBinary 内部的停滞看门狗更快地判死。
 */
const DOWNLOAD_TOTAL_TIMEOUT_MS = 45 * 60_000

/**
 * 渲染操盘纪律切片。
 *
 * 这些规则**不是**本插件发明的新政策，而是编译引擎里已经硬编码的执行事实——
 * 切片的作用是让模型在动手之前就知道这些闸门存在，而不是撞上去才发现。
 *
 * @param {{binary: string, db: string, cap: number}} runtime
 * @returns {string} 可直接注册为 systemPrompt section 的文本
 */
export function renderDiscipline({ binary, db, cap }) {
  return [
    '## lot-trader 操盘纪律',
    '',
    `本机账本 \`${db}\`，引擎二进制 \`${binary}\`，单标满仓额度 ${cap > 0 ? cap : 50000} 元。`,
    '引擎命令已注册成原生工具（`trade_*`）。**操盘一律走工具，不要用 bash 去拼 `trade` 命令**：',
    'bash 路径在受限沙箱下连只读查询都会因 SQLITE_READONLY 失败，而且会绕过下面的审批闸门。',
    '',
    '- **单笔批次独立监控**：每笔买入是一个独立 Lot，不摊薄、不做加权平均成本。谈盈亏就谈「这一笔的含规费保本全成本单价 vs 现价」。',
    '- **严禁深跌冻结**：单笔浮亏 ≤ -20% 属深度击球区，批次必须保持 ACTIVE 并给出 DEEP_VALUE_ALERT 企稳加仓建议，绝不锁死批次、绝不假装它不存在。',
    '- **加仓防抖**：同一父亲缘链 48 小时内只允许加仓一次。被拦是设计如此，不要绕道新建批次来规避冷却。',
    '- **单标的 30% 仓位硬顶**：标的总市值占组合超 30% 时引擎强制拦截加仓。这是真闸门，不许改参数硬闯。',
    '- **多账户强隔离**：底仓代冲做 T 绝不跨券商，可用底仓严格限定在同一 (标的, 账户) 空间内，严防挪用成裸卖空。',
    '- **交易制度**：黄金 ETF 天然 T+0；普通股票/行业 ETF 法定 T+1，首日无交收底仓时裸卖空会被强拦截。',
    '- **写操作需审批**：买入/加仓/平仓/录分红/建账户会先弹审批。审批被拒 = 没有成交，不得改口径宣称已执行。',
    '- **数据诚实**：现价取不到时引擎会回落到买入价，看板会标 degraded。不要把「拿不到现价」讲成「持仓没变化」。',
  ].join('\n')
}

/**
 * 审批闸门的判定逻辑，抽成**纯函数**以便单测覆盖。
 *
 * 关键在最后那条分支：宿主 payload 形状漂移（`exec.name` 取不到）时，
 * `WRITE_TOOLS.includes(undefined)` 是 false —— 直接 return next() 就等于**放行**。
 * 而同一份代码在 HTTP 层的原则是「判断不了就拒绝」。所以这里 fail closed：
 * 认不出工具名就当成写操作，要求审批，并让调用方打一条 Warn。
 *
 * @param {{name?: unknown, arguments?: unknown}} exec
 * @param {{requireApprovalForWrites?: boolean}} settings
 * @returns {{decision: 'ask'|'next', name: string, args: object, failClosed?: boolean}}
 */
export function decideApproval(exec, settings = {}) {
  const name = typeof exec?.name === 'string' ? exec.name : ''
  const args = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}

  if (settings.requireApprovalForWrites === false) {
    return { decision: 'next', name, args }
  }
  if (!name) {
    return { decision: 'ask', name, args, failClosed: true }
  }
  if (WRITE_TOOLS.includes(name)) {
    return { decision: 'ask', name, args }
  }
  return { decision: 'next', name, args }
}

/**
 * 把一次写操作压成一句人话，放进审批提示里——用户得看得见自己要批的是什么。
 *
 * **不允许把关键字段悄悄降级成 `?`**：用户可能因此批准一笔自己没看清的订单。
 * 字段缺失时改为附上截断后的原始入参，让「这笔单到底要干什么」始终可见。
 */
export function describeWrite(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  const acct = a.account ? ` [${a.account}]` : ''
  const summary = (() => {
    switch (name) {
      case TOOL_NAMES.lotBuy:
        return `买入 ${a.symbol ?? '?'} ${a.qty ?? '?'} 股 @ ${a.price ?? '?'}${acct}`
      case TOOL_NAMES.lotAdd:
        return `加仓 ${a.parent_lot_id ?? '?'} @ ${a.price ?? '?'}${a.amount ? ` 投入 ${a.amount} 元` : ''}${acct}`
      case TOOL_NAMES.lotClose:
        return `平仓 ${a.lot_id ?? '?'} @ ${a.price ?? '?'}${a.qty ? ` ${a.qty} 股` : ' 全额'}${a.substitute_core ? '（底仓代冲）' : ''}`
      case TOOL_NAMES.dividendAdd:
        return `录入分红 ${a.symbol ?? '?'} ${a.amount ?? '?'} 元${acct}`
      case TOOL_NAMES.accountAdd:
        return `登记账户 ${a.account_id ?? '?'}`
      default:
        return ''
    }
  })()

  // 认不出工具，或摘要里有没填上的字段 → 补上原始入参，别让用户对着 `?` 点头
  if (!summary || summary.includes('?')) {
    const raw = truncateForPrompt(args)
    const label = summary || `未知写操作 ${name || '(无工具名)'}`
    return `${label}（摘要不完整，原始入参：${raw}）`
  }
  return summary
}

/** 把入参压成一段有上界的文本，供审批提示展示。 */
export function truncateForPrompt(value, max = 300) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (typeof text !== 'string') text = String(text)
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text
}

// ───────────────────────────────────────────────────────── 路由小工具

/**
 * 只服务本机回环请求。
 *
 * `remoteAddress` 缺失时**拒绝**。以前这里把 undefined 当放行，与「两道闸缺一不可」
 * 的表述不一致：真实浏览器请求一定会带 socket 地址，取不到地址说明这条请求
 * 不是走正常 TCP 回环进来的，保守起见交给第二道 Connection 闸处理（它会 401/403）。
 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  const okAddress =
    address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!okAddress) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return true
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * 输出 JSON 响应。
 *
 * **刻意不声明任何 CORS 头**。快照是同源读取的（面板与路由同属宿主 Web 服务），
 * 一旦写上 `access-control-allow-origin: *`，浏览器里**任意网页**都能
 * `fetch('http://127.0.0.1:<port>/api/lot-trader/snapshot')` 读到你的持仓与账本——
 * 因为那些请求同样来自 127.0.0.1，loopback 判断根本挡不住。
 * 收紧跨域是这一层的第一道闸。
 */
export function writeJson(response, status, payload) {
  const body = payload === null ? '' : JSON.stringify(payload)
  response.writeHead?.(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end?.(body)
}

/**
 * 快照路由的准入判断，返回 401 / 403 / null（null = 放行）。
 *
 * 两道闸，缺一不可：
 *   1. 物理层：只接受回环 socket（挡住同网段的直接连接）。
 *   2. 身份层：把请求交给 Connection 做 **Host / Origin 检查 + 浏览器凭据认证**。
 *      只做第 1 道是不够的——浏览器里任意页面发起的 fetch 也来自回环，
 *      必须靠 Connection 的 Origin 与凭据校验才拦得住。
 *
 * Connection 缺席时 **fail closed**：宁可面板不工作，也不把持仓开放出去。
 */
export function authorizeRequest(ctx, request) {
  if (!isLoopbackRequest(request)) return 403

  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  if (!connection || typeof connection.requestRejection !== 'function') return 403

  try {
    return connection.requestRejection({ headers: request?.headers ?? {} }) ?? null
  } catch {
    // 认证链路自身异常 → 同样拒绝，不因为「判断不了」而放行
    return 403
  }
}

/** 把过大的批次数组截断，并如实标注截断。 */
function capLots(board) {
  if (!board) return board
  const truncate = (rows) =>
    rows.length > MAX_INLINE_LOTS ? rows.slice(0, MAX_INLINE_LOTS) : rows
  const truncated = board.lots_count > MAX_INLINE_LOTS
  return {
    ...board,
    lotsByTime: truncate(board.lotsByTime),
    lotsByReturn: truncate(board.lotsByReturn),
    lots_truncated: truncated,
    lots_shown: Math.min(board.lots_count, MAX_INLINE_LOTS),
  }
}

// ─────────────────────────────────────────────────────────── 插件入口

/**
 * 挂载 Host 半边。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 见 cordis.patch.yml
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const initialBinary = resolveBinary(settings.binaryPath)
  const db = resolveDbPath(settings.dbPath)
  const log = (...args) => ctx.logger?.info?.('[lot-trader]', ...args)
  const warn = (...args) => ctx.logger?.warn?.('[lot-trader]', ...args)

  // 配置里可疑的地方不静默吞掉：例如 `cap: "300000"`（带引号）会被容错成数字，
  // 但 `cap: "abc"` 只能回退到 0，用户以为设了其实没设。
  for (const warning of settings.warnings ?? []) warn(warning)

  // ── 可变的二进制状态 ────────────────────────────────────────
  // 自动下载完成前先落到 PATH 兜底；下载完成后原地更新，runner 每次调用都读最新的。
  let binaryPath = initialBinary.path
  let binarySource = initialBinary.source
  /** ready | downloading | failed */
  let binaryStatus = binarySource === 'PATH' && settings.autoDownload ? 'downloading' : 'ready'
  let binaryError = null

  log(`引擎 ${binaryPath}（${binarySource}）| 账本 ${db.path}（${db.source}）`)

  const run = createCliRunner({ binary: () => binaryPath, dbPath: db.path })

  /** 每次都重建，保证快照里的引擎信息反映下载后的真实状态。 */
  function buildEngineInfo() {
    return {
      binary: binaryPath,
      binary_source: binarySource,
      binary_status: binaryStatus,
      binary_error: binaryError,
      binary_tried: initialBinary.tried,
      db: db.path,
      db_source: db.source,
      cap: settings.cap,
      approval_required_for_writes: settings.requireApprovalForWrites,
      auto_download: settings.autoDownload,
      platform_target: platformTarget(),
    }
  }

  /** @type {{generatedAt: string|null, refreshing: boolean, error: string|null, degraded: boolean, degraded_reason: string|null, board: unknown, engine: object}} */
  let snapshot = {
    generatedAt: null,
    refreshing: true,
    error: null,
    degraded: false,
    degraded_reason: null,
    board: null,
    engine: buildEngineInfo(),
  }
  let inflight = null
  let lastReadAt = 0

  function positionArgv() {
    const argv = ['position']
    if (settings.cap > 0) argv.push('--cap', String(settings.cap))
    return argv
  }

  /**
   * 真做一次全量聚合。
   *
   * 两个 CLI 调用各错各的：position 拿不到才叫 degraded（看板的主体没了），
   * stats 拿不到只降级战绩区块——绝不用一个「部分失败」把整块数据说成「空仓」。
   */
  async function collect() {
    const errors = []
    const [positionResult, statsResult] = await Promise.all([run(positionArgv()), run(['stats'])])

    let position = null
    if (positionResult.ok) position = positionResult.data
    else errors.push(`position: ${positionResult.message}`)

    let stats = null
    if (statsResult.ok) stats = statsResult.data
    else errors.push(`stats: ${statsResult.message}`)

    const degraded = position === null
    return {
      generatedAt: new Date().toISOString(),
      refreshing: false,
      error: errors.length ? errors.join('；') : null,
      degraded,
      degraded_reason: degraded
        ? '拿不到 position 视图（下面保留的是上一次成功结果，不是空仓）'
        : errors.length
          ? '战绩统计暂不可用，持仓数据仍然可信'
          : null,
      board: position ? capLots(deriveBoard(position, stats)) : snapshot.board,
      engine: buildEngineInfo(),
    }
  }

  /** 同一时刻只允许一次在途刷新。 */
  function refresh() {
    if (inflight) return inflight
    snapshot = { ...snapshot, refreshing: true }
    inflight = collect()
      .then((next) => {
        snapshot = next
        return snapshot
      })
      .catch((error) => {
        warn('快照刷新失败', error)
        snapshot = {
          ...snapshot,
          refreshing: false,
          degraded: true,
          error: String(error?.message ?? error),
          degraded_reason: '刷新过程自身抛错，下面保留的是上一次成功结果',
        }
        return snapshot
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  // 挂载即探一次，让面板首帧通常就有数据（此后只在有人看时按周期刷新）。
  void refresh()

  // ── 0. 自动补齐引擎二进制 ──────────────────────────────────
  //
  // 探测链走完还落到 PATH 兜底，说明本机没有 trade。若允许自动下载，就从
  // GitHub Releases 拉对应平台的产物到 ~/.lot-trader/bin/，成功后原地切换
  // binaryPath 并立刻重算一次快照——用户不需要做任何手工步骤。
  // 下载失败不静默：binaryStatus 转 failed，面板顶栏会如实显示原因。
  if (binaryStatus === 'downloading') {
    const target = platformTarget()
    if (!target) {
      binaryStatus = 'failed'
      binaryError = `没有为 ${process.platform}-${process.arch} 预编译的 trade 二进制`
      warn(binaryError)
    } else {
      log(`本机没有 trade 二进制，正在从 GitHub Releases 自动下载 ${target} …`)
      void (async () => {
        try {
          // 双层看门狗：
          //   - 内层是 downloadBinary 的「停滞」检测（每收到数据块就重置），
          //     慢链路（实测 95KB/s）能传完，一个字节都不来才判死；
          //   - 这里是外层总时长上限，兜住「一直有零星数据但永远传不完」这种病态情形。
          const downloaded = await downloadBinary({ signal: AbortSignal.timeout(DOWNLOAD_TOTAL_TIMEOUT_MS) })
          binaryPath = downloaded
          binarySource = '自动下载'
          binaryStatus = 'ready'
          binaryError = null
          log(`自动下载完成 → ${downloaded}`)
          // 换到真二进制后立刻重算，面板不必等下一个轮询周期。
          await refresh()
        } catch (error) {
          binaryStatus = 'failed'
          binaryError = String(error?.message ?? error)
          warn(`自动下载失败：${binaryError}`)
        }
      })()
    }
  }

  // ── 1. 模型端工具 ─────────────────────────────────────────
  ctx.inject(['tools'], (toolCtx) => {
    const definitions = createTradeTools({
      run,
      getCap: () => settings.cap,
      // 写成功后立刻让快照失效，看板下一次读取就能看到这笔成交。
      onMutate: () => {
        void refresh()
      },
    })
    for (const definition of definitions) toolCtx.tools.register(definition)
    log(`已注册 ${definitions.length} 个工具（读 ${definitions.length - WRITE_TOOLS.length} / 写 ${WRITE_TOOLS.length}）`)
  })

  // ── 2. 写操作审批闸门 ─────────────────────────────────────
  //
  // 用 waterfall 的 `ask` 而不是 `ctx.tools.guard()`：guard 是同步的、只能 deny，
  // 而这里要的是「挂起等人点头」。非本插件的工具一律 `next()` 让行，
  // 绝不吞掉别人的决策。
  //
  // 判定逻辑抽到 {@link decideApproval}，因为它有一条**必须 fail closed** 的分支：
  // 宿主 payload 形状漂移、取不到工具名时，不能当成「不是写工具」而放行。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const verdict = decideApproval(exec, settings)
    if (verdict.failClosed) {
      warn(`审批闸门拿到无法识别的工具名（${JSON.stringify(exec?.name ?? null)}），按写操作处理并要求审批`)
    }
    if (verdict.decision === 'next') return next()

    const summary = describeWrite(verdict.name, verdict.args)
    return {
      kind: 'ask',
      reason: `lot-trader 即将写入操盘账本：${summary}`,
      displayReason: {
        zh: `即将写入你的操盘账本：${summary}。批准后这笔操作会真实落库。`,
        en: `This will write to your trading ledger: ${summary}. It becomes permanent once approved.`,
      },
    }
  })

  // ── 3. 操盘纪律切片 ───────────────────────────────────────
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: DISCIPLINE_SECTION,
      order: settings.disciplineOrder,
      // 二进制路径是动态的（自动下载完成后会变），所以这里每次组装都现读。
      text: () => renderDiscipline({ binary: binaryPath, db: db.path, cap: settings.cap }),
    })
    log(`操盘纪律切片已注入 systemPrompt（order=${settings.disciplineOrder}）`)
  })

  // ── 4. 看板快照路由 ───────────────────────────────────────
  //
  // `connection` 是**硬依赖**：没有它就做不了浏览器凭据认证，快照路由索性不挂载。
  // 宁可面板拿不到数据，也不把持仓暴露在一个无认证的只读接口上。
  ctx.inject(['webServer', 'connection'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: SNAPSHOT_PATH,
          handler: (request, response) => {
            const rejection = authorizeRequest(scope, request)
            if (rejection) {
              writeJson(response, rejection, { ok: false, error: 'unauthorized' })
              return
            }
            if (request.method === 'OPTIONS') {
              writeJson(response, 204, null)
              return
            }
            if (request.method !== 'GET') {
              writeJson(response, 405, { ok: false, error: 'method not allowed' })
              return
            }
            lastReadAt = Date.now()
            const respond = () => writeJson(response, 200, { ok: true, value: snapshot })
            // 冷启动时让这一次请求顺便等首帧，而不是让面板空转一个刷新周期。
            if (!snapshot.generatedAt) {
              refresh().then(respond, respond)
              return
            }
            respond()
          },
        }),
      'lot-trader: 看板快照路由',
    )

    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: REFRESH_PATH,
          handler: async (request, response) => {
            const rejection = authorizeRequest(scope, request)
            if (rejection) {
              writeJson(response, rejection, { ok: false, error: 'unauthorized' })
              return
            }
            if (request.method === 'OPTIONS') {
              writeJson(response, 204, null)
              return
            }
            if (request.method !== 'POST') {
              writeJson(response, 405, { ok: false, error: 'method not allowed' })
              return
            }
            lastReadAt = Date.now()
            const value = await refresh()
            writeJson(response, 200, { ok: true, value })
          },
        }),
      'lot-trader: 手动刷新路由',
    )
  })

  // ── 5. 周期刷新 ───────────────────────────────────────────
  //
  // 只在「最近有人读过快照」时才真的重算：position 要拉全市场行情与历史 K 线，
  // 没人看的时候每 45 秒烧一次纯属浪费。timer 缺席时降级为纯手动，不崩。
  ctx.inject(['timer'], (scope) => {
    scope.effect(
      () =>
        scope.timer.interval(() => {
          if (Date.now() - lastReadAt < settings.pollMs * 2) void refresh()
        }, settings.pollMs),
      'lot-trader: 周期性快照刷新',
    )
  })
}
