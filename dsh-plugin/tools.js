/**
 * lot-trader · DSH Host 半边 —— CLI 适配层与看板派生。
 *
 * 这一层是**薄适配器**，不是第二套账本：每个工具的 `execute` 只做
 * 「拼 argv → 调 trade → 原样返回 data」，保本单价、浮动盈亏、风控闸门
 * 全部仍住在编译好的 trade 二进制里。因此引擎那些加固过的契约
 * （30% 硬顶、48h 防抖、T+1 底仓代冲隔离、NaN 不进账本）在这里被完整继承，
 * 而不是被复制一遍再慢慢漂移。
 *
 * 三条纪律：
 *   1. **只读即只读**：读工具的 execute 不产生任何 argv 之外的副作用；
 *      改账本的工具单独列进 {@link WRITE_TOOLS}，由 index.js 挂审批闸门。
 *   2. **`--db` 显式透传**：每一次调用都带上解析出来的账本路径，
 *      绝不允许「参数被静默忽略、实际读写默认库」的假隔离。
 *   3. **失败不吞**：CLI 非零退出或返回不可解析输出时抛带 code 的错误，
 *      让模型看到「哪一道闸拦的」，而不是一句被包装过的「调用失败」。
 */

import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────── 常量

const BUNDLE_DIR = dirname(fileURLToPath(import.meta.url))
/** bundle 与仓库二进制同源时（插件住在 lot-trader 仓库内）的候选路径。 */
const REPO_BINARY = resolve(BUNDLE_DIR, '..', 'trade')
const LOCAL_BINARY = join(homedir(), '.local', 'bin', 'trade')
const DEFAULT_DB_PATH = join(homedir(), '.trade', 'trade.db')
/** 自动下载的二进制落盘目录。 */
const CACHE_BIN_DIR = join(homedir(), '.lot-trader', 'bin')
const CACHE_BIN = join(CACHE_BIN_DIR, 'trade')
/** @goodfun-studio/lot-trader GitHub 仓库的 Release 根 URL。 */
const RELEASE_BASE = 'https://github.com/Goodfun-Studio/lot-trader/releases'

const CLI_TIMEOUT_MS = 180_000
const MAX_BUFFER = 64 * 1024 * 1024

/** 工具名。模型按名字调用，改名等于改协议，所以集中定义、只此一处。 */
export const TOOL_NAMES = Object.freeze({
  position: 'trade_position',
  lotList: 'trade_lot_list',
  scan: 'trade_scan',
  stats: 'trade_stats',
  physics: 'trade_physics',
  dividendList: 'trade_dividend_list',
  lotBuy: 'trade_lot_buy',
  lotAdd: 'trade_lot_add',
  lotClose: 'trade_lot_close',
  dividendAdd: 'trade_dividend_add',
  accountAdd: 'trade_account_add',
})

/**
 * 改账本的工具集合。**唯一**的写集合真相来源：
 * index.js 的审批闸门直接读它，不在别处再列一遍。
 */
export const READ_TOOLS = Object.freeze([
  TOOL_NAMES.position,
  TOOL_NAMES.lotList,
  TOOL_NAMES.scan,
  TOOL_NAMES.stats,
  TOOL_NAMES.physics,
  TOOL_NAMES.dividendList,
])

export const WRITE_TOOLS = Object.freeze([
  TOOL_NAMES.lotBuy,
  TOOL_NAMES.lotAdd,
  TOOL_NAMES.lotClose,
  TOOL_NAMES.dividendAdd,
  TOOL_NAMES.accountAdd,
])

/** 错误对象的默认 code；DB / 路径一类的问题另有更具体的 code。 */
export class TradeCliError extends Error {
  constructor(message, { code = 'TRADE_CLI_ERROR', argv, raw } = {}) {
    super(message)
    this.name = 'TradeCliError'
    this.code = code
    if (argv) this.argv = argv
    if (raw) this.raw = raw
  }
}

// ─────────────────────────────────────────────────────────── 路径解析

/** 展开 `~` 前缀。非字符串与空串一律当「没配」。 */
export function expandHome(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed === '~') return homedir()
  return trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed
}

/**
 * 定位 trade 可执行文件。
 * 顺序：config.binaryPath → bundle 同级仓库二进制 → ~/.local/bin/trade
 *       → 自动下载缓存 (~/.lot-trader/bin/trade) → PATH。
 * 最后一项无法同步验真，交给 execFile 以 ENOENT 暴露，绝不假装找得到。
 */
export function resolveBinary(configuredPath) {
  const configured = expandHome(configuredPath)
  const tried = []
  if (configured) {
    tried.push(configured)
    if (existsSync(configured)) return { path: configured, source: 'config.binaryPath', tried }
  }
  for (const [candidate, source] of [
    [REPO_BINARY, 'bundle 同级仓库二进制'],
    [LOCAL_BINARY, '~/.local/bin/trade'],
    [CACHE_BIN, '自动下载缓存'],
  ]) {
    tried.push(candidate)
    if (existsSync(candidate)) return { path: candidate, source, tried }
  }
  tried.push('PATH 上的 trade')
  return { path: 'trade', source: 'PATH', tried }
}

/** 定位账本。顺序：config.dbPath → $LOT_TRADER_DB → $TRADE_DB_PATH → ~/.trade/trade.db。 */
export function resolveDbPath(configuredPath) {
  const configured = expandHome(configuredPath)
  if (configured) return { path: configured, source: 'config.dbPath' }
  const env = process.env.LOT_TRADER_DB || process.env.TRADE_DB_PATH
  if (env) {
    return {
      path: expandHome(env),
      source: process.env.LOT_TRADER_DB ? '$LOT_TRADER_DB' : '$TRADE_DB_PATH',
    }
  }
  return { path: DEFAULT_DB_PATH, source: '~/.trade/trade.db' }
}

// ───────────────────────────────────────────── 自动下载二进制

/**
 * 把当前运行时映射到 release asset 名。
 *
 * 产物名与仓库 `dist/` 里的既有文件名保持一致（`trade-<os>-<arch>`），
 * 这样本地构建产物和 CI 构建产物可以直接互换。
 * 未预编译的平台返回 null —— 绝不编一个不存在的名字去 404。
 */
export function platformTarget() {
  const p = process.platform
  const a = process.arch
  if (p === 'darwin') return a === 'arm64' ? 'trade-darwin-arm64' : 'trade-darwin-x64'
  if (p === 'linux') return a === 'arm64' ? 'trade-linux-arm64' : 'trade-linux-x64'
  if (p === 'win32') return a === 'arm64' ? 'trade-windows-arm64.exe' : 'trade-windows-x64.exe'
  return null
}

/** 平台映射到 Bun 的编译 target（CI 用）。 */
export function bunBuildTarget(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'windows' : platform
  return `bun-${os}-${arch}`
}

/** 把网络异常翻成一句人话，避免把 `UND_ERR_CONNECT_TIMEOUT` 直接甩给用户。 */
export function describeNetError(error) {
  const name = error?.name
  if (name === 'TimeoutError' || name === 'AbortError') return '请求超时'
  const code = String(error?.cause?.code ?? error?.code ?? '')
  if (code.includes('CONNECT_TIMEOUT')) return '连接超时'
  if (code.includes('ENOTFOUND')) return '域名解析失败'
  if (code.includes('ECONNREFUSED')) return '连接被拒绝'
  if (code.includes('ECONNRESET')) return '连接被重置'
  return code || String(error?.message ?? error)
}

/**
 * 从 GitHub Releases 拉对应平台的 trade 二进制，落盘到 ~/.lot-trader/bin/。
 * 下载完成后 chmod 755。失败抛错——让调用方决定是否降级。
 *
 * 走两条路径：
 *   1. `github.com/.../releases/latest/download/<asset>` —— 标准直链。
 *   2. `api.github.com` 的 asset API —— 当 `github.com` 本身不可达时（部分网络环境
 *      只放行 API 域、不放行主站），API 端会 302 到 release-assets CDN。
 * 实测本机就是这种情况：`github.com` 连接超时，而 `api.github.com` 与
 * `release-assets.githubusercontent.com` 都通。只有一条路径会让这类用户直接失败。
 *
 * @param {object} [options]
 * @param {string} [options.version] 指定版本号，默认 'latest' 取最新 release
 * @param {AbortSignal} [options.signal] 可取消
 * @param {string} [options.repository] 覆盖仓库（默认 Goodfun-Studio/lot-trader）
 * @returns {Promise<string>} 二进制绝对路径
 */
export async function downloadBinary(options = {}) {
  const target = platformTarget()
  if (!target) throw new Error(`没有为 ${process.platform}-${process.arch} 预编译的 trade 二进制`)

  const version = options.version || 'latest'
  const repository = options.repository || 'Goodfun-Studio/lot-trader'
  const callerSignal = options.signal

  /** 标准直链。 */
  const directUrl = version === 'latest'
    ? `${RELEASE_BASE}/latest/download/${target}`
    : `${RELEASE_BASE}/download/${version}/${target}`

  const releaseApiUrl = version === 'latest'
    ? `https://api.github.com/repos/${repository}/releases/latest`
    : `https://api.github.com/repos/${repository}/releases/tags/${version}`

  /**
   * 造一个「单次尝试」的 controller。
   *
   * 三个中止来源：调用方 signal、本次超时、显式 abort()。每次尝试各自持有 controller，
   * 所以掐掉输家不会连带掐掉赢家。
   *
   * ⚠️ `fetch()` 在**收到响应头**时就 resolve，此时 body 还没读完。如果不把超时计时器
   * 清掉，它会在读 body 的中途把连接掐断——大批量下载必踩。所以拿到响应头后必须
   * 调 {@link clearDeadline}，只保留调用方中止链路。
   */
  function attempt(ms) {
    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(new Error('attempt timeout')), ms)
    const onCallerAbort = () => controller.abort(callerSignal?.reason)
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    return {
      signal: controller.signal,
      /** 拿到响应头后调用：撤掉本次超时，但保留调用方中止能力。 */
      clearDeadline() {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      },
      /** 主动中止本次尝试（竞速输掉时用）。 */
      abort(reason) {
        if (!controller.signal.aborted) controller.abort(reason)
      },
      done() {
        this.clearDeadline()
        callerSignal?.removeEventListener('abort', onCallerAbort)
      },
    }
  }

  /** 走 API 解析出 <target> 与 <target>.sha256 两个 asset 的下载入口。 */
  async function resolveApiAssets(ms) {
    const a = attempt(ms)
    try {
      const response = await fetch(releaseApiUrl, {
        signal: a.signal,
        headers: { accept: 'application/vnd.github+json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const release = await response.json()
      const pick = (name) => {
        const asset = Array.isArray(release?.assets) ? release.assets.find((x) => x && x.name === name) : undefined
        return asset
          ? {
              url: `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`,
              headers: { accept: 'application/octet-stream' },
            }
          : null
      }
      return { binary: pick(target), checksum: pick(`${target}.sha256`), tag: release?.tag_name }
    } finally {
      a.done()
    }
  }

  /**
   * 二进制下载：两条路**并行竞速**，谁先拿到 200 的响应头就用谁，另一个立刻中止。
   *
   * 串行会踩坑：`github.com` 若不可达，连接超时能吃掉几十秒，而 API 那条路本可以
   * 立刻成功。并行竞速的耗时只取决于较快的那条。
   */
  async function fetchBinary() {
    const failures = []
    /** 每个尝试自己的 controller，赢家留下、输家掐掉——共享一个会把赢家的 body 一起掐死。 */
    const directSlot = attempt(20_000)
    let apiSlot = null

    const direct = (async () => {
      const response = await fetch(directUrl, { signal: directSlot.signal, redirect: 'follow' })
      if (!response.ok) throw new Error(`直链 HTTP ${response.status}`)
      return { via: 'direct', slot: directSlot, response }
    })()

    const viaApi = (async () => {
      const assets = await resolveApiAssets(15_000)
      if (!assets.binary) throw new Error(`Release ${assets.tag ?? version} 里没有 ${target}`)
      apiSlot = attempt(20_000)
      const response = await fetch(assets.binary.url, {
        signal: apiSlot.signal,
        redirect: 'follow',
        headers: assets.binary.headers,
      })
      if (!response.ok) throw new Error(`API HTTP ${response.status}`)
      return { via: 'api', slot: apiSlot, response }
    })()

    try {
      // Promise.any：先拿到响应头者胜；全败才抛 AggregateError
      const winner = await Promise.any([direct, viaApi])
      // 只掐输的那条。赢家的 signal 必须保持有效，否则它的 body 会一起断流。
      if (winner.via === 'direct') apiSlot?.abort()
      else directSlot.abort()
      // 响应头已到手，撤掉「拿响应头」的超时，否则它会在读 body 时把连接掐断。
      winner.slot.clearDeadline()
      return { response: winner.response, slot: winner.slot }
    } catch (aggregate) {
      directSlot.abort()
      apiSlot?.abort()
      const errors = Array.isArray(aggregate?.errors) ? aggregate.errors : [aggregate]
      for (const error of errors) failures.push(describeNetError(error))
      throw new Error(
        `两条下载路径都失败（${failures.join(' / ')}）。可能原因：本机到 GitHub 不通，` +
          `或该 Release 尚未发布 ${target}。可以手动下载后放到 ${CACHE_BIN}，` +
          `或在 config 里用 binaryPath 指过去，或设置 autoDownload: false`,
      )
    }
  }

  /** 校验和：拿不到就跳过校验（降级而不是阻断）。 */
  async function fetchChecksum(binarySlot) {
    const candidates = [`${directUrl}.sha256`]
    try {
      const assets = await resolveApiAssets(10_000)
      if (assets.checksum) candidates.push(assets.checksum.url)
    } catch {
      // API 拿不到就只用直链
    }
    for (const url of candidates) {
      const a = attempt(10_000)
      try {
        const response = await fetch(url, { signal: a.signal, redirect: 'follow' })
        if (!response.ok) continue
        const hash = (await response.text()).trim().split(/\s+/)[0]
        if (/^[a-f0-9]{64}$/i.test(hash)) return hash
      } catch {
        // 下一条
      } finally {
        a.done()
      }
    }
    return null
  }

  const { response, slot } = await fetchBinary()
  // 读 body 不设短超时：~90MB 在慢链路（实测 95KB/s ≈ 15 分钟）要慢慢传，
  // 只保留调用方中止能力。真正的看门狗是上层工具的 timeoutMs。
  try {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1024) {
      throw new Error('下载到的文件明显小于 trade 二进制（疑似重定向到了 HTML 错误页）')
    }

    const expectedSha256 = await fetchChecksum()
    if (expectedSha256) {
      const actual = createHash('sha256').update(buffer).digest('hex')
      if (actual !== expectedSha256) {
        throw new Error(
          `sha256 不匹配：期望 ${expectedSha256.slice(0, 16)}… 实际 ${actual.slice(0, 16)}…（疑似下载被篡改或截断）`,
        )
      }
    }

    mkdirSync(CACHE_BIN_DIR, { recursive: true })
    writeFileSync(CACHE_BIN, buffer)
    chmodSync(CACHE_BIN, 0o755)
    return CACHE_BIN
  } finally {
    slot.done()
  }
}

/** 把 config 补齐成完整形状；缺项一律给安全默认值。 */
export function normalizeConfig(config = {}) {
  const raw = config && typeof config === 'object' ? config : {}
  const pollSeconds = Number.isFinite(raw.pollSeconds) ? raw.pollSeconds : 45
  const cap = Number.isFinite(raw.cap) && raw.cap > 0 ? raw.cap : 0
  const disciplineOrder = Number.isFinite(raw.disciplineOrder) ? raw.disciplineOrder : 170
  return {
    binaryPath: typeof raw.binaryPath === 'string' ? raw.binaryPath : '',
    dbPath: typeof raw.dbPath === 'string' ? raw.dbPath : '',
    cap,
    pollMs: Math.max(15, pollSeconds) * 1000,
    requireApprovalForWrites: raw.requireApprovalForWrites !== false,
    disciplineOrder,
    autoDownload: raw.autoDownload !== false,
  }
}

// ─────────────────────────────────────────────────────────── CLI 调用

/** 宽容地解析 JSON：先整体试，再退到首 `{` 到末 `}` 的切片。 */
export function parseJsonLoose(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // 掉进这里说明 stdout 里混了别的东西（Bun 的堆栈、警告行……）
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function tail(text, max = 400) {
  const value = String(text ?? '').trim()
  return value.length > max ? `…${value.slice(-max)}` : value
}

/**
 * 造一个绑定到具体二进制与账本的 CLI 执行器。
 *
 * `--json` 与 `--db <path>` 由这里统一追加，调用方只负责子命令自己的参数——
 * 这样「忘了传 --db」在结构上就不可能发生。
 *
 * `binary` 既可以是字符串，也可以是返回字符串的函数：自动下载完成前先落到
 * PATH 兜底、下载完成后原地指向缓存路径，不需要重建 runner。
 */
export function createCliRunner({ binary, dbPath, timeoutMs = CLI_TIMEOUT_MS } = {}) {
  const readBinary = typeof binary === 'function' ? binary : () => binary

  /** 执行一次 CLI 调用并解析结果。 */
  function callOnce(args) {
    const bin = readBinary()
    const argv = [...args, '--json', '--db', dbPath]
    return new Promise((settle) => {
      execFile(
        bin,
        argv,
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          const out = String(stdout ?? '')
          const err = String(stderr ?? '')
          const envelope = parseJsonLoose(out) ?? parseJsonLoose(err)

          if (envelope && typeof envelope === 'object') {
            if (envelope.code === 0) {
              settle({ ok: true, data: envelope.data, envelope, argv })
              return
            }
            settle({
              ok: false,
              message: String(envelope.msg ?? 'CLI 返回非零 code'),
              code: `CLI_CODE_${envelope.code}`,
              raw: tail(err || out),
              argv,
            })
            return
          }

          if (!error) {
            settle({
              ok: false,
              message: 'CLI 没有返回可解析的 JSON',
              code: 'CLI_NO_JSON',
              raw: tail(out || err),
              argv,
            })
            return
          }

          const timedOut = Boolean(error.killed) || error.code === 'ETIMEDOUT'
          settle({
            ok: false,
            message: timedOut
              ? `CLI 超过 ${timeoutMs}ms 未返回，已终止`
              : String(error.message ?? error),
            code: error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : timedOut ? 'CLI_TIMEOUT' : 'CLI_FAILED',
            raw: tail(err || out),
            argv,
          })
        },
      )
    })
  }

  /** SQLITE_BUSY_RECOVERY 可自愈：陈旧 WAL/SHM 残留 → 删掉重试一次。 */
  function isRecoveryLock(result) {
    return !result.ok && (result.raw ?? '').includes('SQLITE_BUSY_RECOVERY')
  }

  /**
   * @param {string[]} args 子命令及其参数，例如 `['lot','buy','--symbol','518880.SH', …]`
   * @returns {Promise<{ok: boolean, data?: unknown, envelope?: unknown, message?: string, code?: string, raw?: string, argv: string[]}>}
   */
  return async function run(args) {
    const first = await callOnce(args)
    if (!isRecoveryLock(first)) return first
    try { unlinkSync(dbPath + '-wal') } catch {}
    try { unlinkSync(dbPath + '-shm') } catch {}
    return callOnce(args)
  }
}

/**
 * 跑一次 CLI，失败即抛。工具层只关心「拿到 data」或「抛出去」。
 * @throws {TradeCliError}
 */
export async function runOrThrow(run, args, label) {
  const result = await run(args)
  if (!result.ok) {
    throw new TradeCliError(`${label} 失败：${result.message}${result.raw ? ` —— ${result.raw}` : ''}`, {
      code: result.code,
      argv: result.argv,
      raw: result.raw,
    })
  }
  return result.data
}

// ─────────────────────────────────────────────────────── 看板派生逻辑

/** 把某个标的下挂批次摘掉，只留聚合标量（供模型概览与标的卡片使用）。 */
export function stripLots(target) {
  if (!target || typeof target !== 'object') return target
  const { lots, ...rest } = target
  return { ...rest, lots_count: Array.isArray(lots) ? lots.length : 0 }
}

/**
 * 盈亏率分层梯队。负数越深越靠前，供「盈亏率维度视图」做分层透视。
 * 阈值与引擎的扫描线保持一致：-20% 深跌击球区、+10%/+20% 止盈档。
 */
export const RETURN_BUCKETS = Object.freeze([
  { id: 'deep-value', label: '深度击球区 (≤ -20%)', test: (r) => r <= -0.2 },
  { id: 'dip', label: '深跌观察区 (-20% ~ -10%)', test: (r) => r > -0.2 && r <= -0.1 },
  { id: 'pullback', label: '浅度回撤梯队 (-10% ~ 0)', test: (r) => r > -0.1 && r < 0 },
  { id: 'flat', label: '成本线附近 (0 ~ +10%)', test: (r) => r >= 0 && r < 0.1 },
  { id: 'take-profit', label: '止盈梯队 (+10% ~ +20%)', test: (r) => r >= 0.1 && r < 0.2 },
  { id: 'peak', label: '高位浮盈梯队 (≥ +20%)', test: (r) => r >= 0.2 },
])

function bucketFor(rate) {
  for (const bucket of RETURN_BUCKETS) if (bucket.test(rate)) return bucket.id
  return 'flat'
}

function numeric(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 把 `trade position --json` 的原始三层视图 + `trade stats --json`
 * 折成看板直接可渲染的形状。
 *
 * 两个批次视图在这里就物理分开：`lotsByTime`（买入时间倒序）与
 * `lotsByReturn`（盈亏率倒序）是**两个独立数组**，不是同一个数组的两种排法——
 * 这样前端的两个子切换卡不可能退化成「靠表头排序糊在一起」。
 */
export function deriveBoard(position, stats) {
  const portfolio = position?.portfolio_summary ?? null
  const targets = Array.isArray(position?.targets) ? position.targets : []

  const lots = []
  for (const target of targets) {
    for (const lot of Array.isArray(target?.lots) ? target.lots : []) {
      const rate = numeric(lot.return_rate)
      lots.push({
        ...lot,
        return_rate: rate,
        floating_pnl: numeric(lot.floating_pnl),
        market_value: Math.round(numeric(lot.current_price) * numeric(lot.remaining_quantity) * 100) / 100,
        symbol_name: lot.symbol_name ?? target?.name ?? lot.symbol,
        asset_class: target?.asset_class ?? '',
        portfolio_weight: numeric(target?.portfolio_weight),
        bucket: bucketFor(rate),
      })
    }
  }

  const lotsByTime = [...lots].sort((a, b) => String(b.buy_time ?? '').localeCompare(String(a.buy_time ?? '')))
  const lotsByReturn = [...lots].sort((a, b) => b.return_rate - a.return_rate)

  const bucketCounts = RETURN_BUCKETS.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    count: lots.filter((l) => l.bucket === bucket.id).length,
    floating_pnl:
      Math.round(lots.filter((l) => l.bucket === bucket.id).reduce((sum, l) => sum + l.floating_pnl, 0) * 100) / 100,
  }))

  return {
    portfolio,
    symbols: targets.map(stripLots),
    lots_count: lots.length,
    lotsByTime,
    lotsByReturn,
    bucketCounts,
    stats: stats ?? null,
  }
}

// ───────────────────────────────────────────────────────── 工具定义

const text = (description, required = false) => ({
  type: 'string',
  description,
  ...(required ? { required: true } : {}),
})
const number = (description, required = false) => ({
  type: 'number',
  description,
  ...(required ? { required: true } : {}),
})
const integer = (description, required = false) => ({
  type: 'integer',
  description,
  ...(required ? { required: true } : {}),
})
const bool = (description, required = false) => ({
  type: 'boolean',
  description,
  ...(required ? { required: true } : {}),
})

/**
 * 把裸属性对象包成**合法 JSON Schema**：`{type:"object", properties:{…}, required:[…]}`。
 *
 * 为什么必须有这个包装：工具定义里的 `parameters` 会原样作为 JSON Schema 发给模型 API。
 * 裸属性字典（`{ symbol: { type:"string", required:true } }`）缺 `type`/`properties`，
 * 且 `required` 塞在属性节点里是非法位置——严格的 provider 会直接报错。
 *
 * 属性节点里的 `required` 布尔值在这里被**解构剔除**（而不是置 undefined），
 * 否则对象层会留下值为 undefined 的脏键，让 `'required' in prop` 这类判断误判。
 */
const params = (props, required = []) => ({
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(props).map(([key, { required: _ignored, ...node }]) => [key, node]),
  ),
  // 空数组不写进 schema，保持「没有必填项」的最小表达
  ...(required.length > 0 ? { required } : {}),
})

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const GENERIC_CALL_KIND = { read: 'read', write: 'execute' }

/** 工具结果统一用 object 收口；返回什么由 CLI 的 data 决定。 */
const OUTPUT = (description) => ({ schema: { type: 'object', description }, render: renderJson })

/** 把 undefined / '' 挡在 argv 之外，避免出现 `--reason undefined`。 */
function push(argv, flag, value) {
  if (value === undefined || value === null || value === '') return
  argv.push(flag, String(value))
}

function pushBool(argv, flag, value) {
  if (value === true) argv.push(flag)
}

/**
 * 造 lot-trader 的全部模型端工具。
 *
 * @param {object} options
 * @param {(args: string[]) => Promise<object>} options.run 绑定好 `--json --db` 的执行器
 * @param {() => number} options.getCap 当前单标满仓额度
 * @param {() => void} [options.onMutate] 改账本成功后触发（用于让看板快照立刻失效）
 * @returns {ReadonlyArray<object>} 可直接 `ctx.tools.register(...)` 的定义
 */
export function createTradeTools({ run, getCap, onMutate } = {}) {
  if (typeof run !== 'function') throw new TypeError('createTradeTools: 需要传入 run')

  const call = (args, label) => runOrThrow(run, args, label)
  /** 写工具成功后就地通知看板失效——不在别处再挂一个 tools/result 监听。 */
  const mutated = (value) => {
    if (typeof onMutate === 'function') {
      try {
        onMutate()
      } catch {
        // 快照失效失败绝不能把一次已经落库的成交变成工具错误
      }
    }
    return value
  }

  return Object.freeze([
    // ── 读：持仓全景 ────────────────────────────────────────
    {
      name: TOOL_NAMES.position,
      description:
        '持仓全景聚合视图（引擎口径：单笔批次独立核算，不摊薄成本）。返回组合总览、各标的双重仓位占比与建议加/减仓价位。' +
        '默认**不**返回逐笔批次明细（活跃批次多时体积巨大），只给 lots_count；需要逐笔明细时把 include_lots 置真，' +
        '或改用 trade_lot_list。',
      parameters: params({
        symbol: text('只看向单个标的，支持简写（518880 / 600519 / 000001）'),
        account: text('只统计某个券商账户（如 CMB / PA / DEFAULT）'),
        cap: number('单标满仓额度（元），覆盖插件配置里的 cap'),
        include_lots: bool('是否内联每个标的下挂的逐笔活跃批次明细，默认 false'),
      }, []),
      output: OUTPUT('组合总览 + 各标的聚合（逐笔批次可选内联）'),
      presentCall: (args) => ({
        card: 'generic',
        title: '读取持仓全景',
        kind: GENERIC_CALL_KIND.read,
        rawInput: args?.symbol ?? args?.account ?? '全部账户',
      }),
      presentResult: (_args, result) => {
        const value = result?.value ?? {}
        const summary = value.portfolio_summary ?? {}
        const targets = Array.isArray(value.targets) ? value.targets : []
        const pnl = numeric(summary.total_floating_pnl)
        return {
          card: 'generic',
          title: `持仓全景：${targets.length} 标的 / ${summary.total_active_lots ?? 0} 活跃批次`,
          content: [
            {
              type: 'text',
              text:
                `总成本 ${summary.total_cost ?? 0} 元 | 总市值 ${summary.total_market_value ?? 0} 元 | ` +
                `浮盈 ${pnl >= 0 ? '+' : ''}${pnl} 元 (${((numeric(summary.overall_return_rate)) * 100).toFixed(2)}%)`,
            },
          ],
        }
      },
      async execute(args) {
        const argv = ['position']
        push(argv, '--symbol', args?.symbol)
        push(argv, '--account', args?.account)
        const cap = Number.isFinite(args?.cap) && args.cap > 0 ? args.cap : getCap()
        if (cap > 0) push(argv, '--cap', cap)
        const view = await call(argv, 'trade position')
        if (args?.include_lots === true) return view
        const targets = Array.isArray(view?.targets) ? view.targets : []
        return { ...view, targets: targets.map(stripLots), lots_inlined: false }
      },
    },

    // ── 读：批次明细 ────────────────────────────────────────
    {
      name: TOOL_NAMES.lotList,
      description:
        '在场批次逐笔明细（每笔买入一个独立 Lot）。排序与截断在插件侧完成：sort_by 支持 buy_time（买入时间，默认倒序）' +
        '与 return_rate（浮动收益率倒序）。活跃批次可能上百笔，务必用 limit/offset 翻页，不要一次性拉全量。',
      parameters: params({
        symbol: text('只看向单个标的，支持简写'),
        account: text('只看向某个券商账户'),
        status: text('批次状态，默认 ACTIVE；也可传 CLOSED 或 ALL 看已平仓', false),
        sort_by: text('排序维度：buy_time（默认）或 return_rate'),
        limit: integer('返回条数上限，默认 50，最大 500'),
        offset: integer('翻页偏移，默认 0'),
      }, []),
      output: OUTPUT('排序并截断后的批次行 + 总数'),
      presentCall: (args) => ({
        card: 'generic',
        title: '读取在场批次明细',
        kind: GENERIC_CALL_KIND.read,
        rawInput: args ?? {},
      }),
      presentResult: (_args, result) => {
        const value = result?.value ?? {}
        return {
          card: 'generic',
          title: `批次明细：${value.returned ?? 0}/${value.total ?? 0} 笔`,
          content: [{ type: 'text', text: JSON.stringify(value.rows ?? [], null, 2) }],
        }
      },
      async execute(args) {
        const argv = ['lot', 'list']
        const status = typeof args?.status === 'string' && args.status.trim() ? args.status.trim().toUpperCase() : 'ACTIVE'
        if (status !== 'ALL') push(argv, '--status', status)
        push(argv, '--symbol', args?.symbol)
        push(argv, '--account', args?.account)
        const data = await call(argv, 'trade lot list')
        // CLI 可能返回数组，也可能包一层；两种都接住。
        const rows = Array.isArray(data) ? data : Array.isArray(data?.lots) ? data.lots : []
        const sortBy = String(args?.sort_by ?? 'buy_time') === 'return_rate' ? 'return_rate' : 'buy_time'
        const sorted =
          sortBy === 'return_rate'
            ? [...rows].sort((a, b) => numeric(b?.return_rate) - numeric(a?.return_rate))
            : [...rows].sort((a, b) => String(b?.buy_time ?? '').localeCompare(String(a?.buy_time ?? '')))
        const limit = Math.min(500, Math.max(1, Number.isFinite(args?.limit) ? args.limit : 50))
        const offset = Math.max(0, Number.isFinite(args?.offset) ? args.offset : 0)
        return {
          total: rows.length,
          returned: sorted.slice(offset, offset + limit).length,
          offset,
          limit,
          sort_by: sortBy,
          rows: sorted.slice(offset, offset + limit),
        }
      },
    },

    // ── 读：盘中信号 ────────────────────────────────────────
    {
      name: TOOL_NAMES.scan,
      description:
        '盘中实时扫描操盘信号。捕获 TAKE_PROFIT_ALERT（浮盈 +10%~+20%）、TRAILING_STOP_ALERT（浮盈过 +15% 激活跟踪后自高点回撤）、' +
        'ADD_POSITION_ALERT / DEEP_VALUE_ALERT（浮亏触及加仓区间或 -20% 深跌击球区）。信号按账户隔离标注。',
      parameters: params({ account: text('只扫描某个券商账户') }, []),
      output: OUTPUT('命中的操盘信号列表'),
      presentCall: () => ({ card: 'generic', title: '扫描操盘信号', kind: GENERIC_CALL_KIND.read }),
      presentResult: (_args, result) => {
        const value = result?.value
        const list = Array.isArray(value) ? value : Array.isArray(value?.signals) ? value.signals : []
        return {
          card: 'generic',
          title: `操盘信号：${list.length} 条`,
          content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
        }
      },
      async execute(args) {
        const argv = ['scan']
        push(argv, '--account', args?.account)
        return call(argv, 'trade scan')
      },
    },

    // ── 读：战绩归因 ────────────────────────────────────────
    {
      name: TOOL_NAMES.stats,
      description:
        '复盘战绩统计：总平仓笔数、综合胜率、累计净利润、盈亏比，并按操盘类别（普通波段 / 天然 T+0 / 底仓代冲做 T）与标的归因。',
      parameters: params({
        days: integer('只统计最近 N 天的平仓流水'),
        symbol: text('只归因单个标的'),
        account: text('只归因某个券商账户'),
      }, []),
      output: OUTPUT('战绩统计与多维归因'),
      presentCall: (args) => ({ card: 'generic', title: '复盘战绩统计', kind: GENERIC_CALL_KIND.read, rawInput: args ?? {} }),
      presentResult: (_args, result) => {
        const s = result?.value ?? {}
        return {
          card: 'generic',
          title: `战绩：${s.total_trades ?? 0} 笔平仓，胜率 ${((numeric(s.win_rate)) * 100).toFixed(2)}%`,
          content: [
            {
              type: 'text',
              text: `累计净利润 ${s.total_realized_pnl ?? 0} 元 | 盈亏比 ${s.profit_factor ?? 0} | 日内做 T ${s.day_trades_count ?? 0} 笔`,
            },
          ],
        }
      },
      async execute(args) {
        const argv = ['stats']
        push(argv, '--days', Number.isFinite(args?.days) ? args.days : undefined)
        push(argv, '--symbol', args?.symbol)
        push(argv, '--account', args?.account)
        return call(argv, 'trade stats')
      },
    },

    // ── 读：物理动量雷达 ────────────────────────────────────
    {
      name: TOOL_NAMES.physics,
      description:
        '标的物理运动量化雷达（腾讯财经前复权历史 K 线驱动）：动量速度 v、加速度 a、惯性质量 m、多空净合力 F、' +
        '置信度加权有效合力 F_eff、流体阻尼 μ、60/250 日空间分位。置信等级 LOW 下的强 F 只算「待换手放大确认」的候选信号，不作重仓依据。',
      parameters: params({ symbol: text('标的代码，支持简写', true) }, ['symbol']),
      output: OUTPUT('该标的的物理动量雷达指标'),
      presentCall: (args) => ({ card: 'generic', title: `物理雷达 ${args?.symbol ?? ''}`, kind: GENERIC_CALL_KIND.read }),
      presentResult: (_args, result) => {
        const v = result?.value ?? {}
        return {
          card: 'generic',
          title: `物理雷达：${v.symbol ?? ''} F_eff=${v.effective_force ?? 'n/a'} (${v.confidence_level ?? 'n/a'})`,
          content: [{ type: 'text', text: JSON.stringify(v, null, 2) }],
        }
      },
      async execute(args) {
        if (!args?.symbol) throw new TradeCliError('trade physics 需要 symbol', { code: 'E_MISSING_SYMBOL' })
        return call(['physics', '--symbol', String(args.symbol)], 'trade physics')
      },
    },

    // ── 读：现金分红 ────────────────────────────────────────
    {
      name: TOOL_NAMES.dividendList,
      description: '现金分红流水查询，按标的或账户筛选，返回流水明细与合计分红金额。',
      parameters: params({ symbol: text('按标的筛选'), account: text('按账户筛选') }, []),
      output: OUTPUT('分红流水与合计'),
      presentCall: () => ({ card: 'generic', title: '查询分红流水', kind: GENERIC_CALL_KIND.read }),
      async execute(args) {
        const argv = ['dividend', 'list']
        push(argv, '--symbol', args?.symbol)
        push(argv, '--account', args?.account)
        return call(argv, 'trade dividend list')
      },
    },

    // ── 写：买入建仓 ────────────────────────────────────────
    {
      name: TOOL_NAMES.lotBuy,
      description:
        '买入建仓，生成一个独立批次（Lot）。会真实写入账本，因此需要用户审批。数量必须是整百股；' +
        '成交价会叠加规费算出保本全成本单价。触发单标的 30% 组合仓位硬顶时引擎会直接拒绝。',
      parameters: params({
        symbol: text('标的代码，支持简写（518880 / 600519 / 000001）', true),
        price: number('成交单价（元）', true),
        qty: integer('成交股数，必须为整百', true),
        account: text('券商账户代码，省略则记入 DEFAULT'),
        reason: text('建仓决策理由，会随批次长期留存'),
        fee: number('显式手续费（元），省略则按费率自动估算'),
      }, ['symbol', 'price', 'qty']),
      output: OUTPUT('新批次的 lot_id、账户与含规费保本单价'),
      presentCall: (args) => ({
        card: 'generic',
        title: `买入 ${args?.symbol ?? ''} ${args?.qty ?? ''} 股 @ ${args?.price ?? ''}`,
        kind: GENERIC_CALL_KIND.write,
        rawInput: args ?? {},
      }),
      async execute(args) {
        const argv = ['lot', 'buy']
        push(argv, '--symbol', args?.symbol)
        push(argv, '--price', args?.price)
        push(argv, '--qty', args?.qty)
        push(argv, '--account', args?.account)
        push(argv, '--reason', args?.reason)
        push(argv, '--fee', args?.fee)
        return mutated(await call(argv, 'trade lot buy'))
      },
    },

    // ── 写：梯级加仓 ────────────────────────────────────────
    {
      name: TOOL_NAMES.lotAdd,
      description:
        '对已有批次梯级加仓，自动绑定父子血缘并递增加仓层级。会真实写入账本，因此需要用户审批。' +
        '受两道硬闸门约束：同一父亲缘链 48 小时内只允许加仓一次；单标的组合占比超 30% 直接拦截。',
      parameters: params({
        parent_lot_id: text('父批次 ID', true),
        price: number('本次加仓成交单价（元）', true),
        amount: number('本次投入金额（元），默认 10000，按 100 股向下取整'),
        qty: integer('直接指定加仓股数（优先于 amount）'),
        account: text('券商账户，省略则自动继承父批次账户'),
        reason: text('加仓理由'),
      }, ['parent_lot_id', 'price']),
      output: OUTPUT('新批次的 lot_id 与血缘层级'),
      presentCall: (args) => ({
        card: 'generic',
        title: `加仓 ${args?.parent_lot_id ?? ''} @ ${args?.price ?? ''}`,
        kind: GENERIC_CALL_KIND.write,
        rawInput: args ?? {},
      }),
      async execute(args) {
        const argv = ['lot', 'add']
        push(argv, '--parent-lot-id', args?.parent_lot_id)
        push(argv, '--price', args?.price)
        push(argv, '--amount', args?.amount)
        push(argv, '--qty', args?.qty)
        push(argv, '--account', args?.account)
        push(argv, '--reason', args?.reason)
        return mutated(await call(argv, 'trade lot add'))
      },
    },

    // ── 写：指定批次平仓 ────────────────────────────────────
    {
      name: TOOL_NAMES.lotClose,
      description:
        '平掉指定批次，支持全额与部分平仓（部分平仓后批次保持 ACTIVE 继续监控）。会真实写入账本，因此需要用户审批。' +
        '普通股票/行业 ETF 是法定 T+1：当日买入的批次若无交收底仓，必须显式 substitute_core 走底仓代冲，' +
        '且代冲严格限定在同一 (标的, 账户) 空间内，绝不跨券商冲抵。',
      parameters: params({
        lot_id: text('要平仓的批次 ID', true),
        price: number('平仓成交单价（元）', true),
        qty: integer('平仓股数，省略则全额平掉剩余数量'),
        account: text('券商账户（底仓代冲时必填，用于锁定同账户底仓）'),
        substitute_core: bool('是否用交收底仓代冲完成日内等效 T+0 平仓'),
        reason: text('平仓复盘理由'),
      }, ['lot_id', 'price']),
      output: OUTPUT('本次平仓的实现盈亏与批次剩余状态'),
      presentCall: (args) => ({
        card: 'generic',
        title: `平仓 ${args?.lot_id ?? ''} @ ${args?.price ?? ''}${args?.substitute_core ? '（底仓代冲）' : ''}`,
        kind: GENERIC_CALL_KIND.write,
        rawInput: args ?? {},
      }),
      async execute(args) {
        const argv = ['lot', 'close']
        push(argv, '--lot-id', args?.lot_id)
        push(argv, '--price', args?.price)
        push(argv, '--qty', args?.qty)
        push(argv, '--account', args?.account)
        push(argv, '--reason', args?.reason)
        pushBool(argv, '--substitute-core', args?.substitute_core)
        return mutated(await call(argv, 'trade lot close'))
      },
    },

    // ── 写：录入分红 ────────────────────────────────────────
    {
      name: TOOL_NAMES.dividendAdd,
      description: '录入一笔现金分红流水。会真实写入账本，因此需要用户审批。',
      parameters: params({
        symbol: text('标的代码', true),
        amount: number('到账金额（元）', true),
        date: text('除息/到账日期，形如 2026-07-15，省略则记当前时间'),
        account: text('券商账户'),
        notes: text('备注'),
      }, ['symbol', 'amount']),
      output: OUTPUT('新录入的分红流水'),
      presentCall: (args) => ({
        card: 'generic',
        title: `录入分红 ${args?.symbol ?? ''} ${args?.amount ?? ''} 元`,
        kind: GENERIC_CALL_KIND.write,
        rawInput: args ?? {},
      }),
      async execute(args) {
        const argv = ['dividend', 'add']
        push(argv, '--symbol', args?.symbol)
        push(argv, '--amount', args?.amount)
        push(argv, '--date', args?.date)
        push(argv, '--account', args?.account)
        push(argv, '--notes', args?.notes)
        return mutated(await call(argv, 'trade dividend add'))
      },
    },

    // ── 写：登记账户 ────────────────────────────────────────
    {
      name: TOOL_NAMES.accountAdd,
      description:
        '登记一个券商账户，用于多账户独立核算与底仓代冲隔离。会真实写入账本，因此需要用户审批。' +
        '重复的 account_id 会被引擎拒绝。',
      parameters: params({
        account_id: text('账户代码，如 CMB_MAIN', true),
        name: text('账户显示名'),
        broker: text('券商代码，如 CMB / IBKR / CUSTOM'),
        currency: text('币种，默认 CNY'),
      }, ['account_id']),
      output: OUTPUT('新登记的账户记录'),
      presentCall: (args) => ({
        card: 'generic',
        title: `登记账户 ${args?.account_id ?? ''}`,
        kind: GENERIC_CALL_KIND.write,
        rawInput: args ?? {},
      }),
      async execute(args) {
        const argv = ['account', 'add']
        push(argv, '--id', args?.account_id)
        push(argv, '--name', args?.name)
        push(argv, '--broker', args?.broker)
        push(argv, '--currency', args?.currency)
        return mutated(await call(argv, 'trade account add'))
      },
    },
  ])
}
