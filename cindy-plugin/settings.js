(function () {
  'use strict';

  var CHANNEL = 'lot-trader';
  var channel = new BroadcastChannel(CHANNEL);
  var $ = function (id) { return document.getElementById(id); };
  var currentInstallReq = null;
  var lastWake = 0;

  function wake() {
    if (Date.now() - lastWake < 20000) return;
    lastWake = Date.now();
    try { fetch('/wake').catch(function () {}); } catch (e) {}
  }

  function uid(prefix) {
    return (prefix || 'req') + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  }

  /** 发请求 + 等回执：先 /wake，再每 800ms 重发，直到收到同 reqId 的回执或超时。 */
  function rpc(payload, replyType, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var reqId = payload.reqId || uid('req');
      payload.reqId = reqId;
      var settled = false;
      var timer = null;
      function onMsg(ev) {
        var m = ev && ev.data;
        if (!m || m.type !== replyType || m.reqId !== reqId) return;
        if (settled) return;
        settled = true;
        cleanup();
        resolve(m);
      }
      function cleanup() {
        clearInterval(timer);
        clearTimeout(deadline);
        channel.removeEventListener('message', onMsg);
      }
      var deadline = setTimeout(function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('电子脑没有回应（可能插件未启用或正在更新），请重开设置页或稍后重试。'));
      }, timeoutMs || 20000);
      channel.addEventListener('message', onMsg);
      var send = function () { wake(); channel.postMessage(payload); };
      timer = setInterval(send, 800);
      send();
    });
  }

  // ── 状态渲染 ──
  function renderStatus(data) {
    var badge = $('status-badge');
    var path = $('status-path');
    if (data && data.found) {
      badge.textContent = '已找到';
      badge.className = 'badge badge-ok';
      path.textContent = data.path + (data.source === 'settings' ? '（自定义路径）' : '') + ' · 账本 ' + data.db;
    } else {
      badge.textContent = '未找到';
      badge.className = 'badge badge-no';
      path.textContent = '尚未安装引擎。可用下方「一键下载安装」，或手动安装后点「重新检测」。';
    }
  }

  function setMsg(text, cls) {
    var m = $('msg');
    m.textContent = text || '';
    m.className = 'msg' + (cls ? ' ' + cls : '');
  }

  // ── 引擎检测 ──
  async function check() {
    $('status-badge').textContent = '检测中…';
    $('status-badge').className = 'badge badge-wait';
    $('status-path').textContent = '';
    try {
      var reply = await rpc({ type: 'engine:status:request' }, 'engine:status:reply', 20000);
      if (reply.ok) renderStatus(reply.data);
      else { renderStatus(null); setMsg(reply.message || '检测失败', 'err'); }
    } catch (err) {
      renderStatus(null);
      setMsg(err.message, 'err');
    }
  }

  // ── 保存自定义路径 ──
  async function save() {
    var value = $('binary-path').value.trim();
    try {
      await fetch('/kv', { method: 'PUT', body: JSON.stringify({ binaryPath: value }) });
      setMsg('已保存。', 'ok');
      await check();
    } catch (err) {
      setMsg('保存失败：' + (err && err.message ? err.message : String(err)), 'err');
    }
  }

  // ── 一键安装 ──
  async function install() {
    $('btn-install').disabled = true;
    $('btn-save').disabled = true;
    $('btn-recheck').disabled = true;
    $('progress-wrap').classList.remove('hidden');
    setProgress('准备中…', 0, null);
    setMsg('');
    try {
      var reply = await rpc({ type: 'engine:install:request' }, 'engine:install:reply', 15 * 60 * 1000 + 60000);
      if (reply.ok && reply.data && reply.data.installed) {
        setProgress('安装完成', 100, 100);
        setMsg('安装完成：' + reply.data.path, 'ok');
      } else {
        setMsg('安装失败：' + (reply.message || '未知原因'), 'err');
      }
    } catch (err) {
      setMsg('安装失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      currentInstallReq = null;
      $('btn-install').disabled = false;
      $('btn-save').disabled = false;
      $('btn-recheck').disabled = false;
      await check();
    }
  }

  function phaseLabel(phase) {
    return ({ platform: '识别平台…', download: '下载中…', install: '安装中…' })[phase] || phase || '处理中…';
  }
  function setProgress(label, pct, loaded, total) {
    $('progress-phase').textContent = label;
    var bar = $('progress-bar');
    if (typeof pct === 'number') {
      bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
      $('progress-pct').textContent = Math.round(pct) + '%';
    } else if (typeof loaded === 'number' && typeof total === 'number' && total > 0) {
      var p = (loaded / total) * 100;
      bar.style.width = Math.max(0, Math.min(100, p)) + '%';
      $('progress-pct').textContent = Math.round(p) + '%';
    } else {
      $('progress-pct').textContent = '';
    }
  }

  // 进度事件（下载阶段来自宿主 download-progress）
  channel.addEventListener('message', function (ev) {
    var m = ev && ev.data;
    if (!m || m.type !== 'engine:install:progress') return;
    if (m.phase === 'download' || m.phase === 'install' || m.phase === 'platform') {
      setProgress(phaseLabel(m.phase), undefined, m.loaded, m.total);
      return;
    }
    // 宿主 download-progress：phase 为 queued/downloading/verifying/retrying/...
    var label = ({
      queued: '排队中…', downloading: '下载中…', verifying: '校验中…',
      retrying: '重试中…', completed: '下载完成', failed: '下载失败', cancelled: '已取消',
    })[m.phase] || phaseLabel(m.phase);
    setProgress(label, undefined, m.loaded, m.total);
    if (m.phase === 'failed') setMsg('下载失败，可重试或改用手动安装。', 'err');
  });

  // ── 初始化 ──
  (async function init() {
    try {
      var cfg = await (await fetch('/kv')).json();
      if (cfg && typeof cfg.binaryPath === 'string') $('binary-path').value = cfg.binaryPath;
    } catch (e) {}
    $('btn-save').onclick = save;
    $('btn-recheck').onclick = check;
    $('btn-install').onclick = install;
    check();
    // 设置页也要唤醒电子脑（其可能处于按需态）
    wake();
  })();
})();
