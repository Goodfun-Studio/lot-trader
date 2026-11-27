(function () {
  'use strict';
  var CH_NAME = 'lot-trader';
  var channel = new BroadcastChannel(CH_NAME);
  var state = { snap: null, view: 'symbols', account: '' };
  var currentReq = null;

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }
  function money(v) { return n(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
  function signed(v) { var x = n(v); return (x >= 0 ? '+' : '') + money(x); }
  function pct(v) { return (n(v) * 100).toFixed(2) + '%'; }
  function pctRaw(v) { return n(v).toFixed(2) + '%'; }
  function signCls(v) { return n(v) >= 0 ? 'up' : 'down'; }
  function shortTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ── 请求快照：先叫醒电子脑（同源 /wake），再广播，按 reqId 重发直到收到回执 ──
  var lastWake = 0;
  function wake() {
    // 官方约定：唤醒用同源相对路径 /wake，节流到 20 秒一次。
    if (Date.now() - lastWake < 20000) return;
    lastWake = Date.now();
    try { fetch('/wake').catch(function () {}); } catch (e) {}
  }

  function requestSnapshot() {
    var reqId = 'req-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    currentReq = reqId;
    var send = function () {
      if (currentReq !== reqId) return;
      wake();
      channel.postMessage({ type: 'snapshot:request', reqId: reqId });
    };
    var tries = 0;
    // 快照要拉全市场行情，可能几十秒；重发只是确保电子脑起来后能收到，
    // 电子脑侧按 reqId 去重，不会重复跑 CLI。
    var timer = setInterval(function () {
      if (currentReq !== reqId) { clearInterval(timer); return; }
      send();
      if (++tries > 150) { clearInterval(timer); showError('电子脑没有回应，请重开面板或稍后重试。'); }
    }, 800);
    wake();
    send();
    $('refresh').disabled = true;
    setTimeout(function () { $('refresh').disabled = false; }, 1200);
  }

  channel.onmessage = function (ev) {
    var msg = ev.data || {};
    if (msg.type !== 'snapshot:reply') return;
    if (msg.reqId !== currentReq) return; // 丢弃迟到的旧回执
    currentReq = null;
    if (!msg.ok) { showError(msg.message || '读取失败'); return; }
    state.snap = msg.data || {};
    hideBanner();
    renderAll();
  };

  function showError(text) {
    var b = $('banner');
    b.className = 'banner err';
    b.textContent = text;
    b.classList.remove('hidden');
    $('view').innerHTML = '<div class="empty">暂无数据</div>';
  }
  function hideBanner() { $('banner').classList.add('hidden'); }

  // ── 渲染 ──
  function renderAll() {
    var s = state.snap || {};
    var d = s.degraded || {};
    var b = $('banner');
    if (d.position || d.stats) {
      var parts = [];
      if (d.position) parts.push('持仓数据获取失败：' + esc(s.reasons && s.reasons.position || '原因未知'));
      if (d.stats) parts.push('战绩数据获取失败');
      b.className = 'banner';
      b.innerHTML = parts.join('；');
      b.classList.remove('hidden');
    } else { hideBanner(); }

    $('meta').textContent = s.fetched_at ? '更新于 ' + shortTime(s.fetched_at) : '—';
    renderPortfolio();
    renderView();
  }

  function renderPortfolio() {
    var p = (state.snap && state.snap.portfolio) || null;
    var el = $('portfolio');
    if (!p) { el.innerHTML = ''; return; }
    var cells = [
      ['总成本', money(p.total_cost), ''],
      ['总市值', money(p.total_market_value), ''],
      ['总浮动盈亏', signed(p.total_floating_pnl), signCls(p.total_floating_pnl)],
      ['总收益率', pct(p.overall_return_rate), signCls(p.overall_return_rate)],
      ['活跃批次', String(p.total_active_lots == null ? '—' : p.total_active_lots), ''],
      ['持仓标的', String(p.total_symbols_count == null ? '—' : p.total_symbols_count), ''],
    ];
    el.innerHTML = cells.map(function (c) {
      return '<div class="pf-cell"><div class="pf-l">' + c[0] + '</div><div class="pf-v ' + c[2] + '">' + c[1] + '</div></div>';
    }).join('');
  }

  function lotsAll() {
    var s = state.snap || {};
    return Array.isArray(s.lots) ? s.lots.slice() : [];
  }
  function accounts() {
    var set = {};
    lotsAll().forEach(function (l) { if (l && l.account_id) set[l.account_id] = 1; });
    return Object.keys(set).sort();
  }

  function renderView() {
    var v = $('view');
    if (!state.snap) { v.innerHTML = '<div class="empty">加载中…</div>'; return; }
    if (state.view === 'symbols') { v.innerHTML = viewSymbols(); bindSymbols(); }
    else if (state.view === 'time') { v.innerHTML = viewLots('time'); bindFilter(); }
    else if (state.view === 'rate') { v.innerHTML = viewLots('rate'); bindFilter(); }
    else { v.innerHTML = viewStats(); }
  }

  function viewSymbols() {
    var targets = (state.snap.targets || []).slice();
    if (!targets.length) return '<div class="empty">当前没有持仓标的</div>';
    targets.sort(function (a, b) { return n(b.market_value) - n(a.market_value); });
    return targets.map(function (t) {
      var w = n(t.portfolio_weight);
      var warn = w >= 0.30;
      var ph = t.physics || {};
      return '' +
      '<div class="card">' +
        '<div class="card-hd">' +
          '<span class="card-name">' + esc(t.name || t.symbol) + '</span>' +
          '<span class="card-code">' + esc(t.symbol) + (t.asset_class ? ' · ' + esc(t.asset_class) : '') + '</span>' +
          '<span class="card-badge">' + esc(t.settlement_mode || '') + '</span>' +
        '</div>' +
        '<div class="card-grid">' +
          kv('现价', money(t.current_price)) +
          kv('收益率', '<span class="' + signCls(t.overall_return_rate) + '">' + pct(t.overall_return_rate) + '</span>') +
          kv('浮动盈亏', '<span class="' + signCls(t.total_floating_pnl) + '">' + signed(t.total_floating_pnl) + '</span>') +
          kv('持仓市值', money(t.market_value)) +
          kv('总成本', money(t.total_cost_basis)) +
          kv('均价 / 最近买入', money(t.avg_cost_price) + ' / ' + money(t.last_buy_price)) +
          kv('建议加仓 ≤', '<span class="muted">' + money(t.recommended_buy_in_point) + '</span>') +
          kv('建议止盈 ≥', '<span class="muted">' + money(t.recommended_sale_out_point) + '</span>') +
        '</div>' +
        '<div class="meter">' +
          '<div class="meter-l"><span>组合占比（30% 为加仓硬顶）</span><span class="' + (warn ? 'down' : 'muted') + '">' + pct(w) + (warn ? ' · 超顶' : '') + '</span></div>' +
          '<div class="meter-t"><div class="meter-f' + (warn ? ' warn' : '') + '" style="width:' + Math.min(100, Math.max(2, w * 100)) + '%"></div></div>' +
        '</div>' +
        (ph && ph.confidence_level ? '<div class="radar">物理雷达：F<sub>eff</sub> <b>' + (ph.effective_force == null ? '—' : n(ph.effective_force).toFixed(3)) + '</b>' +
          ' · 置信 <b>' + esc(ph.confidence_level) + '</b>' +
          ' · 60日分位 ' + pctRaw(ph.pct_rank_60) + ' · 回撤 ' + pctRaw(ph.pullback_60) +
          (ph.confidence_level === 'LOW' ? ' <span class="muted">（参与度不足，待确认）</span>' : '') + '</div>' : '') +
      '</div>';
    }).join('');
    function kv(k, v) { return '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
  }

  function bindSymbols() {}

  function viewLots(mode) {
    var accs = accounts();
    var filterHtml = accs.length > 1
      ? '<select class="filter" id="accFilter"><option value="">全部账户</option>' +
        accs.map(function (a) { return '<option value="' + esc(a) + '"' + (state.account === a ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') +
        '</select>'
      : '';
    var lots = lotsAll().filter(function (l) { return !state.account || l.account_id === state.account; });
    if (!lots.length) return '<div class="bar-strip">' + filterHtml + '</div><div class="empty">没有匹配的活跃批次</div>';

    var strip, sorted, head;
    if (mode === 'time') {
      sorted = lots.slice().sort(function (a, b) { return String(b.buy_time || '').localeCompare(String(a.buy_time || '')); });
      var now = Date.now(), h48 = 0, addLv = 0, syms = {};
      lots.forEach(function (l) {
        var t = Date.parse(l.buy_time);
        if (isFinite(t) && now - t <= 48 * 3600 * 1000) h48++;
        if (n(l.pyramid_level) >= 1) addLv++;
        syms[l.symbol] = 1;
      });
      strip = chip('最近买入', shortTime(sorted[0] && sorted[0].buy_time)) +
              chip('48h 内建仓/加仓', h48 + ' 笔') +
              chip('加仓批次 L2+', addLv + ' 笔') +
              chip('涉及标的', Object.keys(syms).length + ' 个');
      head = '时间维度视图（按买入时间倒序，追踪资金进出轨迹）';
    } else {
      sorted = lots.slice().sort(function (a, b) { return n(b.return_rate) - n(a.return_rate); });
      var buckets = [
        ['高位浮盈', function (r) { return r > 0.20; }],
        ['止盈梯队', function (r) { return r > 0.05 && r <= 0.20; }],
        ['成本线', function (r) { return r > 0 && r <= 0.05; }],
        ['浅度回撤', function (r) { return r <= 0 && r > -0.10; }],
        ['深跌观察', function (r) { return r <= -0.10 && r > -0.20; }],
        ['深度击球', function (r) { return r <= -0.20; }],
      ];
      strip = buckets.map(function (b) {
        var hit = lots.filter(function (l) { return b[1](n(l.return_rate)); });
        var sum = hit.reduce(function (s, l) { return s + n(l.floating_pnl); }, 0);
        return chip(b[0], hit.length + ' 笔 · ' + signed(sum) + ' 元');
      }).join('');
      head = '盈亏率维度视图（按浮动收益率倒序，识别待止盈梯队与风险暴露）';
    }

    var rows = sorted.map(function (l) {
      return '<tr>' +
        '<td class="sym">' + esc(l.symbol_name || l.symbol) + '<div class="card-code">' + esc(l.symbol) + '</div></td>' +
        '<td class="acct">' + esc(l.account_id || '') + '</td>' +
        '<td>' + (mode === 'time' ? shortTime(l.buy_time) : (n(l.pyramid_level) > 0 ? 'L' + (n(l.pyramid_level) + 1) : '首仓')) + '</td>' +
        '<td>' + money(l.buy_price) + '</td>' +
        '<td>' + money(l.cost_basis_unit) + '</td>' +
        '<td>' + money(l.remaining_quantity) + '</td>' +
        '<td>' + money(l.current_price) + '</td>' +
        '<td class="' + signCls(l.return_rate) + '">' + pct(l.return_rate) + '</td>' +
        '<td class="' + signCls(l.floating_pnl) + '">' + signed(l.floating_pnl) + '</td>' +
        '<td>' + (l.can_sell_now ? '<span class="tag">可卖</span>' : '<span class="tag">T+1</span>') + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="bar-strip">' + filterHtml + '</div>' +
      '<div class="sec-title">' + head + '</div>' +
      '<div class="bar-strip">' + strip + '</div>' +
      '<table><thead><tr><th>标的</th><th>账户</th><th>' + (mode === 'time' ? '买入时间' : '层级') + '</th><th>成交价</th><th>保本单价</th><th>数量</th><th>现价</th><th>收益率</th><th>浮盈</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function bindFilter() {
    var f = $('accFilter');
    if (!f) return;
    f.onchange = function () { state.account = f.value; renderView(); };
  }

  function viewStats() {
    var st = state.snap.stats;
    if (!st) return '<div class="empty">暂无战绩数据</div>';
    var types = st.by_trade_type || {};
    var typeRows = Object.keys(types).map(function (k) {
      var t = types[k] || {};
      var label = { regular_swing: '普通波段', native_t0: '天然 T+0', core_substitution_t0: '底仓代冲做 T' }[k] || k;
      return '<tr><td>' + esc(label) + '</td><td>' + n(t.total_trades) + '</td><td>' + pct(t.win_rate) + '</td><td class="' + signCls(t.total_realized_pnl) + '">' + signed(t.total_realized_pnl) + '</td></tr>';
    }).join('');

    var syms = Object.keys(st.by_symbol || {}).map(function (k) { return { k: k, v: st.by_symbol[k] }; });
    syms.sort(function (a, b) { return n(b.v.total_realized_pnl) - n(a.v.total_realized_pnl); });
    var top = syms.slice(0, 5).map(symRow).join('');
    var bottom = syms.slice(-5).reverse().map(symRow).join('');
    function symRow(s) {
      return '<tr><td>' + esc((s.v && s.v.name) || s.k) + '</td><td>' + n(s.v.total_trades) + '</td><td>' + pct(s.v.win_rate) + '</td><td class="' + signCls(s.v.total_realized_pnl) + '">' + signed(s.v.total_realized_pnl) + '</td></tr>';
    }

    return '' +
      '<div class="bar-strip">' +
        chip('总平仓', n(st.total_trades) + ' 笔') +
        chip('胜率', pct(st.win_rate)) +
        chip('累计净利', signed(st.total_realized_pnl) + ' 元') +
        chip('盈亏比', st.profit_factor) +
        chip('日内做 T', n(st.day_trades_count) + ' 笔') +
      '</div>' +
      '<div class="sec-title">按操盘类别归因</div>' +
      '<table><thead><tr><th>类别</th><th>笔数</th><th>胜率</th><th>净利</th></tr></thead><tbody>' + typeRows + '</tbody></table>' +
      '<div class="sec-title">盈利 Top 5</div>' +
      '<table><thead><tr><th>标的</th><th>笔数</th><th>胜率</th><th>净利</th></tr></thead><tbody>' + top + '</tbody></table>' +
      '<div class="sec-title">亏损 Top 5</div>' +
      '<table><thead><tr><th>标的</th><th>笔数</th><th>胜率</th><th>净利</th></tr></thead><tbody>' + bottom + '</tbody></table>';
  }

  function chip(label, value) {
    return '<span class="chip">' + esc(label) + ' <b>' + value + '</b></span>';
  }

  // ── 交互 ──
  $('refresh').onclick = requestSnapshot;
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      state.view = t.getAttribute('data-view');
      renderView();
    };
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.snap) {
      var age = Date.now() - Date.parse(state.snap.fetched_at || 0);
      if (isFinite(age) && age > 60000) requestSnapshot();
    }
  });

  requestSnapshot();
})();
