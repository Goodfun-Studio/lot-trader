/**
 * Lot Trader 操盘引擎 · Cindy 随包 Node 工作进程。
 *
 * 通信：一行一个 JSON-RPC 2.0 对象走 stdin/stdout（协议消息之外的日志一律走 stderr）。
 * 职责：把「工具名 + 参数」翻译成 `trade` CLI 的 argv，起子进程执行并解析 --json 输出。
 *
 * 三条纪律（与 lot-trader 引擎的契约一致）：
 *   1. 只读即只读：读工具的 argv 不产生账本副作用；写工具由 Cindy 的
 *      approval: each-call 在主机层把关，这一层不重复造审批。
 *   2. `--db` 显式透传：每次调用都带上解析出来的账本路径，绝不静默落到别的库。
 *   3. 失败不吞：CLI 非零退出或返回不可解析输出时回结构化错误，
 *      把引擎真实的业务拒绝原因（如 30% 硬顶）原样带出去。
 *
 * 引擎二进制：本插件不下载、不打包二进制，只解析本机已装的 `trade`。
 *   顺序：$LOT_TRADER_BIN → ~/.local/bin/trade → ~/.lot-trader/bin/trade
 *         → /usr/local/bin/trade → /opt/homebrew/bin/trade → PATH。
 * 账本路径：$LOT_TRADER_DB → $TRADE_DB_PATH → ~/.trade/trade.db。
 */

'use strict';

const readline = require('node:readline');
const { execFile } = require('node:child_process');
const {
  existsSync,
  accessSync,
  constants,
  mkdirSync,
  copyFileSync,
  chmodSync,
  renameSync,
  unlinkSync,
  statSync,
  createReadStream,
} = require('node:fs');
const { createHash } = require('node:crypto');
const { homedir } = require('node:os');
const { join, isAbsolute, dirname } = require('node:path');

const CLI_TIMEOUT_MS = 180000;
const MAX_BUFFER = 64 * 1024 * 1024;

// ── 协议收发 ──────────────────────────────────────────────────────────

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function respond(id, result) {
  reply({ jsonrpc: '2.0', id: id, result: result });
}

function fail(id, message, data) {
  reply({
    jsonrpc: '2.0',
    id: id,
    error: { code: -32000, message: String(message), data: data || undefined },
  });
}

// ── 路径解析 ──────────────────────────────────────────────────────────

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析引擎路径。优先顺序：调用方传入（来自设置的 binaryPath）→ $LOT_TRADER_BIN
 * → ~/.local/bin/trade → ~/.lot-trader/bin/trade → /usr/local/bin → /opt/homebrew/bin → PATH。
 */
function resolveBinary(explicitPath) {
  const tried = [];
  const envBin = process.env.LOT_TRADER_BIN && process.env.LOT_TRADER_BIN.trim();
  const fromSettings = explicitPath && String(explicitPath).trim();

  const candidates = [];
  if (fromSettings) candidates.push({ p: fromSettings, source: 'settings' });
  if (envBin) candidates.push({ p: envBin, source: 'env' });
  candidates.push({ p: join(homedir(), '.local', 'bin', 'trade'), source: 'known-location' });
  candidates.push({ p: join(homedir(), '.lot-trader', 'bin', 'trade'), source: 'known-location' });
  candidates.push({ p: '/usr/local/bin/trade', source: 'known-location' });
  candidates.push({ p: '/opt/homebrew/bin/trade', source: 'known-location' });

  for (const c of candidates) {
    if (!c.p) continue;
    tried.push(c.p);
    if (isAbsolute(c.p) && existsSync(c.p) && isExecutable(c.p)) {
      return { path: c.p, source: c.source, tried };
    }
  }

  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const p = join(dir, 'trade');
    tried.push(p);
    if (existsSync(p) && isExecutable(p)) return { path: p, source: 'path', tried };
  }

  return { path: null, source: null, tried };
}

/** 引擎默认安装位置（与 README/设置页一致）。 */
function defaultEngineTarget() {
  return join(homedir(), '.local', 'bin', 'trade');
}

/** 当前平台对应的发行资产 key。 */
function currentPlatformKey() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (plat === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (plat === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (plat === 'linux' && arch === 'x64') return 'linux-x64';
  return null;
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const ENGINE_RELEASE_URL = 'https://github.com/Goodfun-Studio/lot-trader/releases';

/** 引擎缺失时的引导式报错：告诉用户去哪装、放哪里、怎么排错。 */
function engineNotFoundMessage(bin) {
  return (
    '找不到本机 trade 引擎，无法执行。请在 Cindy 的「插件 → Lot Trader 操盘引擎 → 设置」里一键下载安装，' +
    '或手动安装：到 ' + ENGINE_RELEASE_URL + ' 下载对应平台（macOS / Linux）的 trade，' +
    '放到 ' + defaultEngineTarget() + ' 并 chmod 755；也可在设置里指定已有路径。' +
    '本次已尝试：' + bin.tried.join('、')
  );
}

// ── 引擎安装与检测 ──────────────────────────────────────────────────

function engineStatus(params) {
  const bin = resolveBinary(params && params.binaryPath);
  const platKey = currentPlatformKey();
  return {
    found: !!bin.path,
    path: bin.path || null,
    source: bin.source || null,
    db: resolveDb(),
    platform: process.platform,
    arch: process.arch,
    platform_key: platKey,
    default_target: defaultEngineTarget(),
  };
}

function enginePlatform() {
  return { platform: process.platform, arch: process.arch, key: currentPlatformKey() };
}

/** 把已下载并校验过的引擎文件复制到目标路径、chmod 755。 */
async function handleEngineInstall(id, params) {
  const target =
    params && typeof params.target === 'string' && params.target.trim()
      ? params.target.trim()
      : defaultEngineTarget();
  const archive = params && params.downloads && params.downloads.archive;
  if (!archive || typeof archive !== 'string') {
    return fail(id, '下载票据缺失或已过期，请重新点「一键安装」。', { errorCode: 'NO_ARCHIVE' });
  }
  if (!existsSync(archive)) {
    return fail(id, '下载文件不存在（可能已过期），请重新点「一键安装」。', { errorCode: 'ARCHIVE_MISSING' });
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = target + '.tmp-' + Date.now();
    copyFileSync(archive, tmp);

    // 二次校验（宿主已验一次，这里 fail-closed 再验一次）。
    if (params && params.sha256) {
      const actual = await sha256File(tmp);
      if (actual !== String(params.sha256).toLowerCase()) {
        unlinkSync(tmp);
        return fail(id, '校验失败：下载文件的 sha256 与预期不符，已中止安装。', { errorCode: 'SHA_MISMATCH' });
      }
    }

    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
    const size = statSync(target).size;
    respond(id, { installed: true, path: target, bytes: size });
  } catch (err) {
    fail(id, '安装引擎失败：' + ((err && err.message) || String(err)), { errorCode: 'INSTALL_FAILED' });
  }
}

function resolveDb() {
  const env = (process.env.LOT_TRADER_DB || process.env.TRADE_DB_PATH || '').trim();
  if (env) return env;
  return join(homedir(), '.trade', 'trade.db');
}

// ── argv 拼装 ─────────────────────────────────────────────────────────

function push(argv, flag, value) {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && value.trim() === '') return;
  argv.push(flag, String(value));
}

function pushBool(argv, flag, value) {
  if (value === true) argv.push(flag);
}

/** 抛出带业务错误码的参数校验错误。 */
function badRequest(message) {
  const err = new Error(message);
  err.errorCode = 'INVALID_ARGS';
  return err;
}

function buildArgv(tool, a) {
  a = a || {};
  switch (tool) {
    case 'trade_position': {
      const argv = ['position'];
      push(argv, '--symbol', a.symbol);
      push(argv, '--account', a.account);
      const cap = Number(a.cap);
      if (Number.isFinite(cap) && cap > 0) push(argv, '--cap', cap);
      return argv;
    }

    case 'trade_lot_list': {
      const argv = ['lot', 'list'];
      const status =
        typeof a.status === 'string' && a.status.trim() ? a.status.trim().toUpperCase() : 'ACTIVE';
      // 无条件透传：引擎 `--status` 默认就是 ACTIVE，不带 flag 等价于只取 ACTIVE，
      // 会让 ALL 静默退化成 ACTIVE-only（DSH 插件踩过的坑）。
      push(argv, '--status', status);
      push(argv, '--symbol', a.symbol);
      push(argv, '--account', a.account);
      return argv;
    }

    case 'trade_scan': {
      const argv = ['scan'];
      push(argv, '--account', a.account);
      return argv;
    }

    case 'trade_stats': {
      const argv = ['stats'];
      const days = Number(a.days);
      if (Number.isFinite(days)) push(argv, '--days', days);
      push(argv, '--symbol', a.symbol);
      push(argv, '--account', a.account);
      return argv;
    }

    case 'trade_physics': {
      if (!a.symbol || String(a.symbol).trim() === '') throw badRequest('trade physics 需要 symbol');
      return ['physics', '--symbol', String(a.symbol)];
    }

    case 'trade_dividend_list': {
      const argv = ['dividend', 'list'];
      push(argv, '--symbol', a.symbol);
      push(argv, '--account', a.account);
      return argv;
    }

    case 'trade_lot_buy': {
      if (!a.symbol) throw badRequest('trade lot buy 需要 symbol');
      if (a.price === undefined || a.price === null) throw badRequest('trade lot buy 需要 price');
      if (a.qty === undefined || a.qty === null) throw badRequest('trade lot buy 需要 qty');
      const argv = ['lot', 'buy'];
      push(argv, '--symbol', a.symbol);
      push(argv, '--price', a.price);
      push(argv, '--qty', a.qty);
      push(argv, '--account', a.account);
      push(argv, '--reason', a.reason);
      push(argv, '--fee', a.fee);
      return argv;
    }

    case 'trade_lot_add': {
      if (!a.parent_lot_id) throw badRequest('trade lot add 需要 parent_lot_id');
      if (a.price === undefined || a.price === null) throw badRequest('trade lot add 需要 price');
      const argv = ['lot', 'add'];
      push(argv, '--parent-lot-id', a.parent_lot_id);
      push(argv, '--price', a.price);
      push(argv, '--amount', a.amount);
      push(argv, '--qty', a.qty);
      push(argv, '--account', a.account);
      push(argv, '--reason', a.reason);
      return argv;
    }

    case 'trade_lot_close': {
      if (!a.lot_id) throw badRequest('trade lot close 需要 lot_id');
      if (a.price === undefined || a.price === null) throw badRequest('trade lot close 需要 price');
      const argv = ['lot', 'close'];
      push(argv, '--lot-id', a.lot_id);
      push(argv, '--price', a.price);
      push(argv, '--qty', a.qty);
      push(argv, '--account', a.account);
      push(argv, '--reason', a.reason);
      pushBool(argv, '--substitute-core', a.substitute_core);
      return argv;
    }

    case 'trade_dividend_add': {
      if (!a.symbol) throw badRequest('trade dividend add 需要 symbol');
      if (a.amount === undefined || a.amount === null)
        throw badRequest('trade dividend add 需要 amount');
      const argv = ['dividend', 'add'];
      push(argv, '--symbol', a.symbol);
      push(argv, '--amount', a.amount);
      push(argv, '--date', a.date);
      push(argv, '--account', a.account);
      push(argv, '--notes', a.notes);
      return argv;
    }

    case 'trade_account_add': {
      if (!a.account_id) throw badRequest('trade account add 需要 account_id');
      // 账户代码是位置参数（引擎用法：trade account add <account_id> --name ...）。
      const argv = ['account', 'add', String(a.account_id)];
      push(argv, '--name', a.name);
      push(argv, '--broker', a.broker);
      push(argv, '--currency', a.currency);
      return argv;
    }

    default:
      throw badRequest('未知工具：' + tool);
  }
}

// ── 执行与解析 ────────────────────────────────────────────────────────

class CliError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.errorCode = errorCode;
  }
}

function runCli(binary, db, argv) {
  return new Promise((resolve, reject) => {
    const full = ['--db', db].concat(argv, ['--json']);
    execFile(
      binary,
      full,
      { timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          let detail = (stderr || '').trim();
          if (!detail && stdout) {
            try {
              const p = JSON.parse(stdout);
              if (p && (p.msg || p.message)) detail = String(p.msg || p.message);
            } catch {
              detail = stdout.trim().slice(0, 600);
            }
          }
          if (!detail) detail = err.message;
          if (err.killed || err.signal) detail = '执行超时或被杀：' + detail;
          reject(new CliError('CLI_FAILED', detail));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          reject(
            new CliError('CLI_NO_JSON', '引擎输出不是合法 JSON：' + String(stdout).trim().slice(0, 600)),
          );
          return;
        }
        if (parsed && typeof parsed === 'object' && 'code' in parsed && parsed.code !== 0) {
          reject(new CliError('CLI_BUSINESS_REJECTED', String(parsed.msg || '引擎拒绝了本次操作')));
          return;
        }
        resolve(parsed);
      },
    );
  });
}

/** 引擎统一信封 {code,msg,data}，这里取出 data；不是信封就原样返回。 */
function unwrap(parsed) {
  if (parsed && typeof parsed === 'object' && 'data' in parsed && 'code' in parsed) return parsed.data;
  return parsed;
}

function stripLots(target) {
  if (!target || typeof target !== 'object') return target;
  const copy = {};
  for (const k of Object.keys(target)) {
    if (k === 'lots') continue;
    copy[k] = target[k];
  }
  return copy;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 工具级后处理：控制体积与排序分页。 */
function postProcess(tool, args, data) {
  if (tool === 'trade_position') {
    if (args && args.include_lots === true) return data;
    const targets = Array.isArray(data && data.targets) ? data.targets : [];
    return Object.assign({}, data, { targets: targets.map(stripLots), lots_inlined: false });
  }

  if (tool === 'trade_lot_list') {
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data && data.lots)
        ? data.lots
        : [];
    const sortBy = String((args && args.sort_by) || 'buy_time') === 'return_rate' ? 'return_rate' : 'buy_time';
    const sorted =
      sortBy === 'return_rate'
        ? rows.slice().sort((x, y) => num(y && y.return_rate) - num(x && x.return_rate))
        : rows
            .slice()
            .sort((x, y) =>
              String((y && y.buy_time) || '').localeCompare(String((x && x.buy_time) || '')),
            );
    const rawLimit = Number(args && args.limit);
    const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));
    const rawOffset = Number(args && args.offset);
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
    return {
      total: rows.length,
      returned: sorted.slice(offset, offset + limit).length,
      offset: offset,
      limit: limit,
      sort_by: sortBy,
      rows: sorted.slice(offset, offset + limit),
    };
  }

  return data;
}

// ── 请求处理 ──────────────────────────────────────────────────────────

async function handleInvoke(id, params) {
  const tool = params && params.tool;
  const args = (params && params.args) || {};

  let argv;
  try {
    argv = buildArgv(tool, args);
  } catch (err) {
    fail(id, err && err.message ? err.message : '参数不合法', { errorCode: 'INVALID_ARGS' });
    return;
  }

  const bin = resolveBinary(params && params.binaryPath);
  if (!bin.path) {
    fail(id, engineNotFoundMessage(bin), { errorCode: 'CLI_NOT_FOUND' });
    return;
  }

  const db = resolveDb();
  try {
    const parsed = await runCli(bin.path, db, argv);
    const data = postProcess(tool, args, unwrap(parsed));
    respond(id, {
      data: data,
      engine: { binary: bin.path, binary_source: bin.source, db: db },
    });
  } catch (err) {
    fail(id, err && err.message ? err.message : 'trade 调用失败', {
      errorCode: (err && err.errorCode) || 'TRADE_CLI_ERROR',
    });
  }
}

// ── 看板快照（面板只读消费） ─────────────────────────────────────────

async function buildSnapshot(binaryPath) {
  const bin = resolveBinary(binaryPath);
  if (!bin.path) {
    throw new CliError('CLI_NOT_FOUND', engineNotFoundMessage(bin));
  }
  const db = resolveDb();
  const snapshot = {
    fetched_at: new Date().toISOString(),
    engine: { binary: bin.path, binary_source: bin.source, db: db },
    portfolio: null,
    targets: [],
    lots: [],
    stats: null,
    degraded: { position: false, stats: false },
    reasons: {},
  };

  // 产物数据与战绩各错各的：绝不因为一半失败就把整块说成“空仓”。
  try {
    const pos = unwrap(await runCli(bin.path, db, ['position'])) || {};
    snapshot.portfolio = pos.portfolio_summary || null;
    const targets = Array.isArray(pos.targets) ? pos.targets : [];
    const flat = [];
    snapshot.targets = targets.map((t) => {
      const lots = Array.isArray(t.lots) ? t.lots : [];
      for (const l of lots) flat.push(l);
      const copy = {};
      for (const k of Object.keys(t)) if (k !== 'lots') copy[k] = t[k];
      copy.lots_count = lots.length;
      return copy;
    });
    snapshot.lots = flat;
  } catch (err) {
    snapshot.degraded.position = true;
    snapshot.reasons.position = (err && err.message) || '未知';
  }

  try {
    snapshot.stats = unwrap(await runCli(bin.path, db, ['stats']));
  } catch (err) {
    snapshot.degraded.stats = true;
    snapshot.reasons.stats = (err && err.message) || '未知';
  }

  return snapshot;
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  if (request.method === 'trade/invoke') {
    handleInvoke(request.id, request.params || {}).catch((err) => {
      fail(request.id, (err && err.message) || '内部错误');
    });
    return;
  }

  if (request.method === 'board/snapshot') {
    buildSnapshot(request.params && request.params.binaryPath)
      .then((snapshot) => respond(request.id, snapshot))
      .catch((err) => fail(request.id, (err && err.message) || '快照构建失败'));
    return;
  }

  if (request.method === 'engine/status') {
    try {
      respond(request.id, engineStatus(request.params || {}));
    } catch (err) {
      fail(request.id, (err && err.message) || '检测失败');
    }
    return;
  }

  if (request.method === 'engine/platform') {
    respond(request.id, enginePlatform());
    return;
  }

  if (request.method === 'engine/install') {
    handleEngineInstall(request.id, request.params || {}).catch((err) => {
      fail(request.id, (err && err.message) || '安装失败');
    });
    return;
  }

  reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
});
