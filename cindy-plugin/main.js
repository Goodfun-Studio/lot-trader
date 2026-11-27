/**
 * Lot Trader 操盘引擎 —— Cindy 插件电子脑（沙箱侧）。
 *
 * 跑在无文件、无 Node、无网络直连的沙箱页里，做三件事：
 *   1. 把当前 Agent 调用的工具原样转交给随包 Node 工作进程（node/worker.cjs）；
 *   2. 给右侧栏看板提供只读快照（面板经 BroadcastChannel 要数据）；
 *   3. 给设置页提供引擎检测与「一键下载安装」编排（下载走 cindy.downloads，落盘走 Node 工作进程）。
 *
 * 审批由 Cindy 在主机的工具声明层完成（写工具声明了 approval: "each-call"），这里不重复造。
 */

/** 本插件接管的工具集合，与 ghost.json 的 tools 一一对应。 */
var TOOLS = {
  trade_position: true,
  trade_lot_list: true,
  trade_scan: true,
  trade_stats: true,
  trade_physics: true,
  trade_dividend_list: true,
  trade_lot_buy: true,
  trade_lot_add: true,
  trade_lot_close: true,
  trade_dividend_add: true,
  trade_account_add: true,
};

/** 面板 / 设置页 / 电子脑共用同一个广播频道。 */
var CHANNEL_NAME = 'lot-trader';
var channel = new BroadcastChannel(CHANNEL_NAME);
/** 已受理的请求编号，避免同一个 reqId 被重发时重复干活。 */
var seenReqIds = [];

/**
 * 引擎发行信息：固定到 v0.1.0，逐平台固定 URL + 字节数 + sha256。
 * cindy.downloads 要求 sha256 与精确字节数，所以必须钉死版本。
 */
var ENGINE_RELEASE = 'v0.1.0';
var ENGINE_DOWNLOAD_BASE =
  'https://github.com/Goodfun-Studio/lot-trader/releases/download/' + ENGINE_RELEASE + '/';
var ENGINE_ASSETS = {
  'darwin-arm64': {
    asset: 'trade-darwin-arm64',
    bytes: 89358050,
    sha256: 'e8395e56ffe216ea0b2f2402e6d9c832d78036a581b7987cf885b133ed336945',
  },
  'darwin-x64': {
    asset: 'trade-darwin-x64',
    bytes: 98364896,
    sha256: '0d525fa6d23c98dfcd68854d45953f3fc05869274dbc42ba8ad317254821b391',
  },
  'linux-arm64': {
    asset: 'trade-linux-arm64',
    bytes: 109431800,
    sha256: '028a09b470e1f7577c20072419e4f30fe1757d99e75614b72e7f7e0ee3b26415',
  },
  'linux-x64': {
    asset: 'trade-linux-x64',
    bytes: 109332656,
    sha256: 'd68e87e108a29ff8e6acd473cabcd1c3c84ba4b479767dc1499ab5acebc925ec',
  },
};

function sendToolResult(callId, ok, body) {
  var payload = { type: 'tool-result', callId: callId, ok: !!ok };
  if (ok) {
    payload.result = body;
  } else {
    payload.errorCode = (body && body.errorCode) || 'TRADE_CLI_ERROR';
    payload.message = (body && body.message) || 'trade 调用失败，未返回具体原因。';
  }
  return cindy.send(payload);
}

/** 读主机代管的 /kv（设置页写入的自定义参数）。 */
async function readKv() {
  try {
    var res = await fetch('/kv');
    return (await res.json()) || {};
  } catch (e) {
    return {};
  }
}

async function binaryPathFromKv() {
  var kv = await readKv();
  return kv && typeof kv.binaryPath === 'string' ? kv.binaryPath : '';
}

// ── Agent 工具调用 ────────────────────────────────────────────────────

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  if (!TOOLS[msg.tool]) return;

  var binaryPath = await binaryPathFromKv();
  var response;
  try {
    response = await cindy.node.request({
      method: 'trade/invoke',
      callId: msg.callId,
      params: { tool: msg.tool, args: msg.args || {}, binaryPath: binaryPath },
      timeoutMs: 120000,
      maxTotalMs: 900000,
    });
  } catch (err) {
    await sendToolResult(msg.callId, false, {
      errorCode: 'NODE_WORKER_ERROR',
      message: '调用本机 trade 工作进程失败：' + (err && err.message ? err.message : String(err)),
    });
    return;
  }

  if (!response || response.ok !== true) {
    await sendToolResult(msg.callId, false, {
      errorCode: response && response.errorCode,
      message: response && response.message,
    });
    return;
  }

  var payload = response.result;
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    payload = payload.data;
  }
  await sendToolResult(msg.callId, true, payload);
});

// ── 下载进度转发（供设置页显示进度条） ───────────────────────────────

cindy.onHostMessage(function (msg) {
  if (!msg || msg.type !== 'event') return;
  if (msg.name === 'download-progress') {
    channel.postMessage({ type: 'engine:install:progress', data: msg.data || {} });
  }
});

// ── 看板 / 设置页请求 ─────────────────────────────────────────────────

function alreadySeen(reqId) {
  if (seenReqIds.indexOf(reqId) !== -1) return true;
  seenReqIds.push(reqId);
  if (seenReqIds.length > 32) seenReqIds.shift();
  return false;
}

async function handleSnapshot(msg) {
  if (alreadySeen(msg.reqId)) return;
  var binaryPath = await binaryPathFromKv();
  var ok, body;
  try {
    var response = await cindy.node.request({
      method: 'board/snapshot',
      params: { binaryPath: binaryPath },
      timeoutMs: 120000,
      maxTotalMs: 900000,
    });
    if (!response || response.ok !== true) {
      ok = false;
      body = { message: (response && response.message) || '读取快照失败' };
    } else {
      ok = true;
      body = response.result;
    }
  } catch (err) {
    ok = false;
    body = { message: '工作进程异常：' + (err && err.message ? err.message : String(err)) };
  }
  channel.postMessage(
    ok
      ? { type: 'snapshot:reply', reqId: msg.reqId, ok: true, data: body }
      : { type: 'snapshot:reply', reqId: msg.reqId, ok: false, message: body.message },
  );
}

async function handleEngineStatus(msg) {
  var binaryPath = await binaryPathFromKv();
  try {
    var response = await cindy.node.request({
      method: 'engine/status',
      params: { binaryPath: binaryPath },
      timeoutMs: 30000,
    });
    if (!response || response.ok !== true) {
      channel.postMessage({ type: 'engine:status:reply', reqId: msg.reqId, ok: false, message: (response && response.message) || '检测失败' });
      return;
    }
    channel.postMessage({ type: 'engine:status:reply', reqId: msg.reqId, ok: true, data: response.result });
  } catch (err) {
    channel.postMessage({ type: 'engine:status:reply', reqId: msg.reqId, ok: false, message: (err && err.message) || '检测失败' });
  }
}

async function handleEngineInstall(msg) {
  function progress(phase, extra) {
    channel.postMessage(Object.assign({ type: 'engine:install:progress', reqId: msg.reqId, phase: phase }, extra || {}));
  }
  function finish(ok, body) {
    channel.postMessage({ type: 'engine:install:reply', reqId: msg.reqId, ok: !!ok, data: body && body.data, message: body && body.message });
  }

  try {
    if (!cindy.downloads || typeof cindy.downloads.start !== 'function') {
      finish(false, { message: '当前 Cindy 版本不支持下载能力（cindy.downloads）。请手动到 GitHub Releases 下载引擎，或升级 Cindy。' });
      return;
    }

    progress('platform');
    var platResp = await cindy.node.request({ method: 'engine/platform', params: {}, timeoutMs: 30000 });
    if (!platResp || platResp.ok !== true) {
      finish(false, { message: (platResp && platResp.message) || '无法识别当前平台' });
      return;
    }
    var key = platResp.result && platResp.result.key;
    var asset = key ? ENGINE_ASSETS[key] : null;
    if (!asset) {
      finish(false, {
        message: '当前平台（' + (platResp.result ? platResp.result.platform + '/' + platResp.result.arch : '未知') + '）没有预编译引擎。目前仅提供 macOS 与 Linux 的 arm64/x64。',
      });
      return;
    }

    var url = ENGINE_DOWNLOAD_BASE + asset.asset;
    progress('download', { url: url, total: asset.bytes, loaded: 0 });
    var dl = await cindy.downloads.start({
      id: 'lot-trader-engine-' + key + '-' + Date.now(),
      url: url,
      sha256: asset.sha256,
      bytes: asset.bytes,
    });
    if (!dl || dl.ok !== true) {
      finish(false, { message: (dl && dl.message) || '下载引擎失败（网络或校验问题）' });
      return;
    }

    progress('install', { total: asset.bytes, loaded: asset.bytes });
    var inst = await cindy.node.request({
      method: 'engine/install',
      params: { target: '', sha256: asset.sha256, bytes: asset.bytes },
      downloadTokens: { archive: dl.token },
      timeoutMs: 120000,
      maxTotalMs: 900000,
    });
    if (!inst || inst.ok !== true) {
      finish(false, { message: (inst && inst.message) || '安装引擎失败' });
      return;
    }
    finish(true, { data: inst.result });
  } catch (err) {
    finish(false, { message: '安装过程出错：' + (err && err.message ? err.message : String(err)) });
  }
}

channel.onmessage = function (ev) {
  var msg = ev && ev.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'snapshot:request') {
    handleSnapshot(msg);
    return;
  }
  if (msg.type === 'engine:status:request') {
    handleEngineStatus(msg);
    return;
  }
  if (msg.type === 'engine:install:request') {
    handleEngineInstall(msg);
    return;
  }
};
