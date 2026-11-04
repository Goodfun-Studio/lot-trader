/**
 * lot-trader · DSH Client 半边 —— 原生持仓看板。
 *
 * 只做两件事：向同源 Host 路由要快照、把它渲染进中央主视口与左侧栏。
 * 浏览器**不直连** `~/.trade/trade.db`，也不直连腾讯行情——现价由 Host 侧的
 * `trade position` 带出来，页面只消费一份只读快照。这样账本不出本机、
 * 密钥与路径不进浏览器，页面也不必自己重算任何成本口径。
 *
 * 布局约定（按 lot-trader 的呈现规范）：
 *   - **在场批次的两个维度物理隔离**：时间维度视图与盈亏率维度视图是两张独立表格，
 *     各自拥有独立的表头说明与统计视角，靠子切换卡物理隔离，
 *     绝不退化成「同一张表 + 表头点一下排序」。
 *   - 容器与控件一律吃宿主主题 token（`--dsw-alias-*`），跟随亮/暗主题。
 */

window.__ModuleLoader__.load({
  id: '@goodfun-studio/dsh-lot-trader',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const SNAPSHOT_PATH = '/api/lot-trader/snapshot'
    const REFRESH_PATH = '/api/lot-trader/refresh'
    const POLL_MS = 30000

    /** 兜底词典：locale 服务缺席时也用中文，不留空标签。 */
    const ZH = {
      title: '持仓操盘看板',
      refresh: '立即重算',
      refreshing: '重算中…',
      updated: '更新于',
      loading: '正在向引擎取数…',
      failed: '取数失败',
      empty: '账本里没有活跃批次。',
      portfolio: '组合总览',
      totalCost: '总持仓成本',
      marketValue: '总市值',
      floatingPnl: '总浮动盈亏',
      returnRate: '总收益率',
      activeLots: '活跃批次',
      symbols: '持仓标的',
      cap: '单标满仓额度',
      symbolsTitle: '标的全景',
      weight: '组合占比',
      costPos: '成本仓位',
      curPos: '市值仓位',
      buyIn: '建议加仓区',
      sellOut: '建议止盈区',
      coreQty: '可用底仓',
      qty: '持仓数量',
      radar: '物理雷达',
      force: '有效合力',
      confidence: '置信',
      confidenceLowNote: '参与度不足，强合力只算待确认候选',
      lots: '在场活跃批次',
      viewTime: '时间维度视图',
      viewReturn: '盈亏率维度视图',
      viewTimeNote: '按买入时间倒序 — 追踪资金进出轨迹、检验 48 小时加仓防抖、复盘近期击球时点',
      viewReturnNote: '按浮动盈亏率倒序 — 识别待止盈梯队、评估下属批次风险暴露、定向挑最深负收益批次做代冲对冲',
      lotId: '批次ID',
      symbol: '标的',
      account: '账户',
      level: '层级',
      buyTime: '买入时间',
      buyPrice: '成交价',
      breakEven: '保本单价',
      price: '现价',
      ret: '收益率',
      pnl: '浮动盈亏',
      sellable: '即刻可卖',
      reason: '买入理由',
      yes: '可卖',
      no: 'T+1 冻结',
      subT0: '天然T+0',
      timeStats: '时间视角',
      latestBuy: '最近买入',
      last48h: '48h 内建仓/加仓',
      pyramid: '加仓批次 (L2+)',
      involvedSymbols: '涉及标的',
      returnStats: '盈亏分层透视',
      stats: '历史平仓战绩',
      totalTrades: '总平仓笔数',
      winRate: '综合胜率',
      realized: '累计净利润',
      profitFactor: '盈亏比',
      dayTrades: '日内做 T',
      byType: '按操盘类别',
      bySymbol: '按标的归因',
      regular: '普通波段',
      nativeT0: '天然 T+0',
      coreSub: '底仓代冲做T',
      trades: '笔',
      filterAccount: '账户',
      filterAll: '全部',
      search: '搜索标的 / 批次ID',
      shown: '显示',
      of: '共',
      truncated: '批次过多，仅显示前',
      records: '条',
      noRows: '没有符合筛选条件的批次。',
      expand: '点击展开此标的的活跃批次',
      collapse: '点击收起',
      lotsForSymbol: '笔活跃批次',
      engine: '引擎',
      ledger: '账本',
    }
    const EN = {
      title: 'Lot Trader Board',
      refresh: 'Recompute',
      refreshing: 'Recomputing…',
      updated: 'updated',
      loading: 'Reading from the engine…',
      failed: 'fetch failed',
      empty: 'No active lots in the ledger.',
      portfolio: 'Portfolio',
      totalCost: 'Total cost',
      marketValue: 'Market value',
      floatingPnl: 'Floating P&L',
      returnRate: 'Return',
      activeLots: 'Active lots',
      symbols: 'Symbols',
      cap: 'Full-position cap',
      symbolsTitle: 'Symbols',
      weight: 'Weight',
      costPos: 'Cost pos.',
      curPos: 'Mkt pos.',
      buyIn: 'Buy zone',
      sellOut: 'Take-profit',
      coreQty: 'Core qty',
      qty: 'Qty',
      radar: 'Radar',
      force: 'F_eff',
      confidence: 'conf',
      confidenceLowNote: 'low participation — treat strong force as unconfirmed',
      lots: 'Active lots',
      viewTime: 'Time-ordered view',
      viewReturn: 'Return-rate ranked view',
      viewTimeNote: 'Newest buy first — capital flow, the 48h cooldown, recent entry points',
      viewReturnNote: 'Best return first — take-profit梯队, risk exposure, deepest losers for core substitution',
      lotId: 'Lot',
      symbol: 'Symbol',
      account: 'Account',
      level: 'Level',
      buyTime: 'Bought',
      buyPrice: 'Buy',
      breakEven: 'Break-even',
      price: 'Last',
      ret: 'Return',
      pnl: 'P&L',
      sellable: 'Sellable',
      reason: 'Thesis',
      yes: 'yes',
      no: 'T+1 locked',
      subT0: 'native T+0',
      timeStats: 'Time lens',
      latestBuy: 'Latest buy',
      last48h: 'Bought in 48h',
      pyramid: 'Pyramid lots (L2+)',
      involvedSymbols: 'Symbols',
      returnStats: 'Return ladder',
      stats: 'Closed trades',
      totalTrades: 'Closed',
      winRate: 'Win rate',
      realized: 'Realized P&L',
      profitFactor: 'Profit factor',
      dayTrades: 'Day trades',
      byType: 'By trade type',
      bySymbol: 'By symbol',
      regular: 'Regular swing',
      nativeT0: 'Native T+0',
      coreSub: 'Core substitution',
      trades: '',
      filterAccount: 'Account',
      filterAll: 'All',
      search: 'Search symbol / lot id',
      shown: 'showing',
      of: 'of',
      truncated: 'Too many lots, showing first',
      records: '',
      noRows: 'No lot matches the filter.',
      engine: 'Engine',
      ledger: 'Ledger',
    }

    // ── 主题 token ────────────────────────────────────────────
    const GREEN = 'var(--dsw-alias-state-success-primary)'
    const RED = 'var(--dsw-alias-state-error-primary)'
    const WARN = 'var(--dsw-alias-state-warn-primary)'
    const IDLE = 'var(--dsw-alias-state-idle-primary)'
    const LABEL = 'var(--dsw-alias-label-primary)'
    const LABEL2 = 'var(--dsw-alias-label-secondary)'
    const BORDER = 'var(--dsw-alias-border-l1)'
    const BORDER2 = 'var(--dsw-alias-border-l2)'
    const LAYER1 = 'var(--dsw-alias-bg-layer-1)'
    const LAYER2 = 'var(--dsw-alias-bg-layer-2)'
    const BRAND = 'var(--dsw-alias-brand-primary)'

    // ── 格式化 ───────────────────────────────────────────────
    const num = (v, fallback = 0) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    /**
     * 值是否**明确不可用**。
     *
     * 必须先判 null/undefined 再走 Number()：`Number(null)` 是 0，
     * 于是「收益率拿不到」会被渲染成「0.00%」——把「不知道」说成「不赚不亏」，
     * 正是这个插件反对的粉饰。空串同理。
     */
    const isUnknown = (v) => v === null || v === undefined || v === ''
    /**
     * 展示用的收益率：**未知就保持未知**。
     *
     * 调用点必须用它，而不是 `num()` —— `num(null)` 与 `num('')` 都会得到 0，
     * 于是 `pct` 里的 isUnknown 守卫收不到 null，未知值照样被渲染成 `0.00%`、
     * 看起来像「不赚不亏」。这正是 issue #6 的第二层。
     */
    const rateOf = (v) => {
      if (isUnknown(v)) return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    function money(v, digits = 2) {
      if (isUnknown(v)) return '—'
      const n = Number(v)
      if (!Number.isFinite(n)) return '—'
      return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    }
    function pct(v, digits = 2) {
      if (isUnknown(v)) return '—'
      const n = Number(v)
      if (!Number.isFinite(n)) return '—'
      return `${(n * 100).toFixed(digits)}%`
    }
    function signedMoney(v, digits = 2) {
      if (isUnknown(v)) return '—'
      const n = Number(v)
      if (!Number.isFinite(n)) return '—'
      return `${n > 0 ? '+' : ''}${money(n, digits)}`
    }
    function pnlColor(v) {
      if (isUnknown(v)) return LABEL2
      const n = Number(v)
      if (!Number.isFinite(n) || n === 0) return LABEL2
      return n > 0 ? GREEN : RED
    }
    function shortTime(value) {
      if (!value) return '—'
      const text = String(value)
      return text.length >= 16 ? text.slice(0, 16).replace('T', ' ') : text
    }
    function clockTime(iso) {
      if (!iso) return '—'
      try {
        return new Date(iso).toLocaleTimeString('zh-CN')
      } catch {
        return String(iso)
      }
    }

    // ── 基础组件 ─────────────────────────────────────────────
    function Card({ children, style, pad = 14 }) {
      return h(
        'div',
        {
          style: {
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            background: LAYER1,
            padding: pad,
            boxSizing: 'border-box',
            ...style,
          },
        },
        children,
      )
    }

    function Stat({ label, value, tone, sub }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('span', { style: { color: LABEL2, fontSize: 11, whiteSpace: 'nowrap' } }, label),
        h(
          'span',
          {
            style: {
              color: tone ?? LABEL,
              fontSize: 17,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            },
          },
          value,
        ),
        sub ? h('span', { style: { color: LABEL2, fontSize: 11, whiteSpace: 'nowrap' } }, sub) : null,
      )
    }

    function Pill({ text, tone = LABEL2, bg }) {
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 6px',
            borderRadius: 999,
            border: `1px solid ${BORDER}`,
            background: bg ?? LAYER2,
            color: tone,
            fontSize: 11,
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          },
        },
        text,
      )
    }

    function Dot({ tone = IDLE, size = 7 }) {
      return h('span', {
        'aria-hidden': true,
        style: { width: size, height: size, borderRadius: '50%', background: tone, flex: '0 0 auto' },
      })
    }

    /** 双仓位占比条：成本仓位与市值仓位各一段，靠满仓额度归一。 */
    function DualBar({ costRate, curRate, weight }) {
      const clamp = (v) => Math.max(0, Math.min(1, num(v)))
      const c = clamp(costRate)
      const m = clamp(curRate)
      const hot = num(weight) >= 0.3
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        h(
          'div',
          {
            style: {
              position: 'relative',
              height: 6,
              borderRadius: 3,
              background: LAYER2,
              overflow: 'hidden',
              border: `1px solid ${BORDER}`,
            },
            title: `成本仓位 ${pct(costRate)} / 市值仓位 ${pct(curRate)}`,
          },
          h('div', {
            style: {
              position: 'absolute',
              inset: 0,
              width: `${c * 100}%`,
              background: hot ? RED : BRAND,
              opacity: 0.45,
            },
          }),
          h('div', {
            style: {
              position: 'absolute',
              inset: 0,
              width: `${m * 100}%`,
              background: hot ? RED : BRAND,
              opacity: 0.9,
            },
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: LABEL2 } },
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `成本 ${pct(costRate, 1)}`),
          h(
            'span',
            { style: { color: hot ? RED : LABEL2, fontVariantNumeric: 'tabular-nums' } },
            `市值 ${pct(curRate, 1)}${hot ? ' ⚠ 30% 硬顶' : ''}`,
          ),
        ),
      )
    }

    function Th({ children, align = 'left', width, style }) {
      return h(
        'th',
        {
          style: {
            textAlign: align,
            padding: '7px 8px',
            color: LABEL2,
            fontWeight: 500,
            fontSize: 11,
            whiteSpace: 'nowrap',
            borderBottom: `1px solid ${BORDER}`,
            background: LAYER2,
            position: 'sticky',
            top: 0,
            zIndex: 1,
            width,
            ...style,
          },
        },
        children,
      )
    }

    function Td({ children, align = 'left', tone, title, mono }) {
      return h(
        'td',
        {
          style: {
            textAlign: align,
            padding: '6px 8px',
            fontSize: 12,
            color: tone ?? LABEL,
            borderBottom: `1px solid ${BORDER}`,
            whiteSpace: 'nowrap',
            fontVariantNumeric: mono === false ? 'normal' : 'tabular-nums',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 220,
          },
          title: title ?? (typeof children === 'string' ? children : undefined),
        },
        children,
      )
    }

    // ── 侧边栏图标 (sidebar.panellist) ───────────────────────
    function LotTraderIcon(props) {
      const size = props?.size ? props.size : 18
      const active = Boolean(props?.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: active ? BRAND : 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { display: 'block', flexShrink: 0, transition: 'stroke 0.15s ease' },
          'aria-hidden': 'true',
        },
        h('rect', { x: 3.5, y: 13.5, width: 4, height: 7, rx: 1 }),
        h('rect', { x: 10, y: 9.5, width: 4, height: 11, rx: 1 }),
        h('rect', { x: 16.5, y: 5.5, width: 4, height: 15, rx: 1 }),
        h('path', { d: 'M5.5 10.5 L12 7 L15.5 8.8 L20.5 3.5' }),
      )
    }

    // ── 取数 ─────────────────────────────────────────────────
    function useSnapshot() {
      const [snapshot, setSnapshot] = useState(null)
      const [failed, setFailed] = useState(null)
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          // 显式声明同源凭据：Host 侧的路由已接入 Connection 做浏览器凭据认证，
          // 不带凭据会被自己的准入闸拦成 401。同源请求本就会带 cookie，
          // 这里写明白是为了让「必须凭据」这件事在代码里可见。
          const response = await fetch(SNAPSHOT_PATH, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          const body = await response.json()
          if (!alive.current) return
          if (body?.ok) {
            setSnapshot(body.value)
            setFailed(null)
          } else {
            setFailed(body?.error ?? `HTTP ${response.status}`)
          }
        } catch (error) {
          if (alive.current) setFailed(String(error?.message ?? error))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load()
        // 页面隐藏时跳过这一轮轮询。宿主侧已经「最近有人读才刷新」，
        // 这里再省一层：没人看的标签页不该继续拉行情（position 要打全市场行情与历史 K 线）。
        const handle = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          void load()
        }, POLL_MS)
        // 从后台切回前台时立刻补一次，避免回来看到过期快照
        const onVisible = () => {
          if (typeof document !== 'undefined' && !document.hidden) void load()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive.current = false
          clearInterval(handle)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])

      const recompute = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(REFRESH_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          const body = await response.json()
          if (alive.current && body?.ok) {
            setSnapshot(body.value)
            setFailed(null)
          }
        } catch (error) {
          if (alive.current) setFailed(String(error?.message ?? error))
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [])

      return { snapshot, failed, busy, load, recompute }
    }

    // ── 组合总览 ─────────────────────────────────────────────
    function SummarySection({ board, t }) {
      const p = board?.portfolio
      if (!p) return null
      const rate = rateOf(p.overall_return_rate)
      const cells = [
        { label: t('totalCost'), value: `${money(p.total_cost)} 元` },
        { label: t('marketValue'), value: `${money(p.total_market_value)} 元` },
        {
          label: t('floatingPnl'),
          value: `${signedMoney(p.total_floating_pnl)} 元`,
          tone: pnlColor(p.total_floating_pnl),
        },
        { label: t('returnRate'), value: pct(rate), tone: pnlColor(rate) },
        { label: t('activeLots'), value: String(p.total_active_lots ?? board.lots_count ?? 0) },
        { label: t('symbols'), value: String(p.total_symbols_count ?? board.symbols?.length ?? 0) },
        { label: t('cap'), value: `${money(p.full_position_cap, 0)} 元` },
      ]
      return h(
        Card,
        { style: { display: 'flex', flexWrap: 'wrap', gap: '14px 28px' } },
        cells.map((cell) => h(Stat, { key: cell.label, ...cell })),
      )
    }

    // ── 标的全景（可穿透展开该标的全部批次） ──────────────────
    function SymbolCard({ target, t, expanded, onToggle, symbolLotsTime, symbolLotsReturn }) {
      const rate = rateOf(target.overall_return_rate)
      const physics = target.physics
      const hot = num(target.portfolio_weight) >= 0.3
      const lotCount = symbolLotsTime?.length ?? 0
      const [subView, setSubView] = useState('time')
      const rows = subView === 'time' ? (symbolLotsTime ?? []) : (symbolLotsReturn ?? [])

      const chipStyle = (active) => ({
        padding: '3px 10px',
        borderRadius: 999,
        border: `1px solid ${active ? BRAND : BORDER}`,
        background: active ? LAYER2 : 'transparent',
        color: active ? LABEL : LABEL2,
        fontSize: 11,
        cursor: 'pointer',
        font: 'inherit',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      })

      return h(
        Card,
        { style: { display: 'flex', flexDirection: 'column', gap: 9, borderColor: hot ? RED : BORDER, overflow: 'hidden' } },
        // 标题栏 —— 仅这一行可点击切换展开/收起
        h(
          'div',
          {
            onClick: onToggle,
            title: expanded ? t('collapse') : t('expand'),
            style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', cursor: 'pointer', userSelect: 'none' },
          },
          h('span', { 'aria-hidden': true, style: { fontSize: 12, color: LABEL2, width: 14, flexShrink: 0, transition: 'transform 0.12s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' } }, '▸'),
          h('span', { style: { fontSize: 14, fontWeight: 600, color: LABEL } }, target.name ?? target.symbol),
          h('span', { style: { fontSize: 11, color: LABEL2 } }, target.symbol),
          h(Pill, { text: target.asset_class ?? '—' }),
          target.settlement_mode === 'NATIVE_T0' ? h(Pill, { text: t('subT0'), tone: BRAND }) : null,
          hot ? h(Pill, { text: `⚠ ${t('weight')} ${pct(target.portfolio_weight, 1)}`, tone: RED }) : null,
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 19, fontWeight: 600, color: LABEL, fontVariantNumeric: 'tabular-nums' } }, money(target.current_price, 3)),
          h('span', { style: { fontSize: 12, color: pnlColor(rate), fontVariantNumeric: 'tabular-nums' } }, `${pct(rate)} · ${signedMoney(target.total_floating_pnl)} 元`),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 11, color: LABEL2 } },
          h('span', null, `${t('qty')} ${money(target.total_quantity, 0)}`),
          h('span', null, `${t('coreQty')} ${money(target.available_core_qty, 0)}`),
          h('span', null, `${t('activeLots')} ${target.lots_count ?? target.active_lots_count ?? 0}`),
        ),
        h(DualBar, {
          costRate: target.cost_position_rate,
          curRate: target.current_position_rate,
          weight: target.portfolio_weight,
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: LABEL2 } },
          h('span', null, `${t('buyIn')} ≤ ${money(target.recommended_buy_in_point, 3)}`),
          h('span', null, `${t('sellOut')} ≥ ${money(target.recommended_sale_out_point, 3)}`),
        ),
        physics
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: 10,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  paddingTop: 7,
                  borderTop: `1px solid ${BORDER}`,
                  fontSize: 11,
                  color: LABEL2,
                },
                title: t('radar'),
              },
              h(Dot, {
                tone:
                  physics.confidence_level === 'HIGH' ? GREEN : physics.confidence_level === 'LOW' ? IDLE : BRAND,
              }),
              h(
                'span',
                { style: { color: pnlColor(physics.effective_force), fontVariantNumeric: 'tabular-nums' } },
                `${t('force')} ${num(physics.effective_force).toFixed(3)}`,
              ),
              h('span', null, `F ${num(physics.F).toFixed(3)}`),
              h('span', null, `a ${num(physics.a).toFixed(3)}`),
              h('span', null, `m ${num(physics.m).toFixed(2)}`),
              h('span', null, `${t('confidence')} ${physics.confidence_level ?? '—'}`),
              h('span', null, `60日分位 ${num(physics.pct_rank_60).toFixed(0)}%`),
              h('span', null, `回撤 ${num(physics.pullback_60).toFixed(1)}%`),
              physics.confidence_level === 'LOW'
                ? h('span', { style: { color: WARN } }, `· ${t('confidenceLowNote')}`)
                : null,
            )
          : null,
        expanded && lotCount > 0
          ? h(
              'div',
              {
                style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: `1px solid ${BORDER2}`, marginTop: 2 },
                onClick: (e) => e.stopPropagation(),
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 } },
                h('span', { style: { fontWeight: 600, color: LABEL } }, `${lotCount} ${t('lotsForSymbol')}`),
                h('button', { type: 'button', onClick: (e) => { e.stopPropagation(); setSubView('time') }, style: chipStyle(subView === 'time') }, '时间维度'),
                h('button', { type: 'button', onClick: (e) => { e.stopPropagation(); setSubView('return') }, style: chipStyle(subView === 'return') }, '盈亏率'),
              ),
              h(LotTable, { rows, view: subView, t, maxHeight: 320 }),
            )
          : null,
      )
    }

    // ── 批次双视图（物理隔离） ───────────────────────────────
    function bucketTone(id) {
      if (id === 'deep-value') return RED
      if (id === 'dip') return WARN
      if (id === 'pullback') return IDLE
      if (id === 'flat') return LABEL2
      if (id === 'take-profit') return GREEN
      // 收益率不可用既不是红也不是绿，单独一个中性色，避免被读成某个盈亏档
      if (id === 'unknown') return LABEL2
      return BRAND
    }

    function LotTable({ rows, view, t, maxHeight }) {
      const timeOrdered = view === 'time'
      const mh = maxHeight ?? 460
      return h(
        'div',
        { style: { overflowX: 'auto', maxHeight: mh, overflowY: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8 } },
        h(
          'table',
          { style: { borderCollapse: 'collapse', width: '100%', minWidth: timeOrdered ? 1040 : 1000 } },
          h(
            'thead',
            null,
            timeOrdered
              ? h(
                  'tr',
                  null,
                  h(Th, null, t('buyTime')),
                  h(Th, null, t('symbol')),
                  h(Th, null, t('lotId')),
                  h(Th, null, t('account')),
                  h(Th, { align: 'center' }, t('level')),
                  h(Th, { align: 'right' }, t('buyPrice')),
                  h(Th, { align: 'right' }, t('breakEven')),
                  h(Th, { align: 'right' }, t('price')),
                  h(Th, { align: 'right' }, t('qty')),
                  h(Th, { align: 'right' }, t('ret')),
                  h(Th, { align: 'right' }, t('pnl')),
                  h(Th, { align: 'center' }, t('sellable')),
                  h(Th, null, t('reason')),
                )
              : h(
                  'tr',
                  null,
                  h(Th, null, t('ret')),
                  h(Th, null, t('symbol')),
                  h(Th, null, t('lotId')),
                  h(Th, null, t('account')),
                  h(Th, { align: 'right' }, t('breakEven')),
                  h(Th, { align: 'right' }, t('price')),
                  h(Th, { align: 'right' }, t('qty')),
                  h(Th, { align: 'right' }, t('marketValue')),
                  h(Th, { align: 'right' }, t('pnl')),
                  h(Th, { align: 'center' }, t('level')),
                  h(Th, { align: 'center' }, t('sellable')),
                  h(Th, null, t('reason')),
                ),
          ),
          h(
            'tbody',
            null,
            rows.map((lot) => {
              const rate = rateOf(lot.return_rate)
              const common = [
                Td({ children: lot.symbol_name ?? lot.symbol, title: `${lot.symbol_name ?? ''} ${lot.symbol}` }),
                Td({ children: lot.lot_id, tone: LABEL2, mono: true }),
                Td({ children: lot.account_id ?? 'DEFAULT', tone: LABEL2 }),
              ]
              const level = Td({
                children: `L${lot.pyramid_level ?? 1}`,
                align: 'center',
                tone: num(lot.pyramid_level) > 1 ? BRAND : LABEL2,
              })
              const sellable = Td({
                children: lot.can_sell_now ? t('yes') : t('no'),
                align: 'center',
                tone: lot.can_sell_now ? GREEN : WARN,
              })
              const reason = Td({
                children: lot.buy_reason ?? '',
                tone: LABEL2,
                title: lot.buy_reason ?? '',
              })
              const cells = timeOrdered
                ? [
                    Td({ children: shortTime(lot.buy_time) }),
                    ...common,
                    level,
                    Td({ children: money(lot.buy_price, 3), align: 'right' }),
                    Td({ children: money(lot.cost_basis_unit, 4), align: 'right', tone: LABEL2 }),
                    Td({ children: money(lot.current_price, 3), align: 'right' }),
                    Td({ children: money(lot.remaining_quantity, 0), align: 'right' }),
                    Td({ children: pct(rate), align: 'right', tone: pnlColor(rate) }),
                    Td({ children: signedMoney(lot.floating_pnl), align: 'right', tone: pnlColor(rate) }),
                    sellable,
                    reason,
                  ]
                : [
                    Td({ children: pct(rate), tone: pnlColor(rate) }),
                    ...common,
                    Td({ children: money(lot.cost_basis_unit, 4), align: 'right', tone: LABEL2 }),
                    Td({ children: money(lot.current_price, 3), align: 'right' }),
                    Td({ children: money(lot.remaining_quantity, 0), align: 'right' }),
                    Td({ children: money(lot.market_value), align: 'right' }),
                    Td({ children: signedMoney(lot.floating_pnl), align: 'right', tone: pnlColor(rate) }),
                    level,
                    sellable,
                    reason,
                  ]
              return h('tr', { key: `${lot.lot_id}:${lot.account_id ?? ''}:${view}` }, cells)
            }),
          ),
        ),
      )
    }

    function LotSection({ board, t }) {
      const [view, setView] = useState('time')
      const [account, setAccount] = useState('ALL')
      const [query, setQuery] = useState('')

      const accounts = useMemo(() => {
        const all = new Set()
        for (const lot of board?.lotsByTime ?? []) all.add(lot.account_id ?? 'DEFAULT')
        return ['ALL', ...Array.from(all).sort()]
      }, [board])

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const match = (lot) => {
          if (account !== 'ALL' && (lot.account_id ?? 'DEFAULT') !== account) return false
          if (!needle) return true
          return (
            String(lot.symbol ?? '').toLowerCase().includes(needle) ||
            String(lot.symbol_name ?? '').toLowerCase().includes(needle) ||
            String(lot.lot_id ?? '').toLowerCase().includes(needle)
          )
        }
        return {
          time: (board?.lotsByTime ?? []).filter(match),
          ret: (board?.lotsByReturn ?? []).filter(match),
        }
      }, [board, account, query])

      const timeStats = useMemo(() => {
        const rows = filtered.time
        if (!rows.length) return null
        const cutoff = Date.now() - 48 * 3600 * 1000
        let last48 = 0
        let pyramid = 0
        const symbols = new Set()
        for (const lot of rows) {
          const at = Date.parse(String(lot.buy_time ?? ''))
          if (Number.isFinite(at) && at >= cutoff) last48 += 1
          if (num(lot.pyramid_level, 1) > 1) pyramid += 1
          symbols.add(lot.symbol)
        }
        return { latest: rows[0]?.buy_time, last48, pyramid, symbols: symbols.size }
      }, [filtered])

      if (!board || board.lots_count === 0) {
        return h(Card, null, h('div', { style: { color: LABEL2, fontSize: 12 } }, t('empty')))
      }

      const rows = view === 'time' ? filtered.time : filtered.ret
      const tabStyle = (active) => ({
        padding: '5px 12px',
        borderRadius: 999,
        border: `1px solid ${active ? BRAND : BORDER}`,
        background: active ? LAYER2 : 'transparent',
        color: active ? LABEL : LABEL2,
        fontSize: 12,
        cursor: 'pointer',
        font: 'inherit',
      })

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, fontWeight: 600, color: LABEL } }, t('lots')),
          h(Pill, { text: `${rows.length} / ${board.lots_count}` }),
          board.lots_truncated ? h(Pill, { text: `${t('truncated')} ${board.lots_shown}`, tone: WARN }) : null,
        ),

        // 子切换卡：两个视图物理隔离，不是同一张表换排序。
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: () => setView('time'), style: tabStyle(view === 'time') }, t('viewTime')),
          h('button', { type: 'button', onClick: () => setView('return'), style: tabStyle(view === 'return') }, t('viewReturn')),
        ),
        h('div', { style: { fontSize: 11, color: LABEL2 } }, view === 'time' ? t('viewTimeNote') : t('viewReturnNote')),

        // 筛选条
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11, color: LABEL2 } }, t('filterAccount')),
          h(
            'select',
            {
              value: account,
              onChange: (event) => setAccount(event.target.value),
              style: {
                padding: '3px 8px',
                borderRadius: 6,
                border: `1px solid ${BORDER}`,
                background: LAYER2,
                color: LABEL,
                fontSize: 12,
                font: 'inherit',
              },
            },
            accounts.map((value) =>
              h('option', { key: value, value }, value === 'ALL' ? t('filterAll') : value),
            ),
          ),
          h('input', {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: t('search'),
            style: {
              padding: '4px 8px',
              borderRadius: 6,
              border: `1px solid ${BORDER}`,
              background: LAYER2,
              color: LABEL,
              fontSize: 12,
              font: 'inherit',
              minWidth: 180,
            },
          }),
        ),

        // 每个视图自己的统计视角
        view === 'time'
          ? h(
              Card,
              { pad: 10, style: { display: 'flex', gap: 26, flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 11, color: LABEL2, alignSelf: 'center' } }, t('timeStats')),
              h(Stat, { label: t('latestBuy'), value: shortTime(timeStats?.latest) }),
              h(Stat, { label: t('last48h'), value: String(timeStats?.last48 ?? 0), tone: timeStats?.last48 ? WARN : LABEL }),
              h(Stat, { label: t('pyramid'), value: String(timeStats?.pyramid ?? 0) }),
              h(Stat, { label: t('involvedSymbols'), value: String(timeStats?.symbols ?? 0) }),
            )
          : h(
              Card,
              { pad: 10, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('span', { style: { fontSize: 11, color: LABEL2 } }, t('returnStats')),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                (board.bucketCounts ?? []).map((bucket) =>
                  h(
                    'div',
                    {
                      key: bucket.id,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 9px',
                        borderRadius: 8,
                        border: `1px solid ${BORDER}`,
                        background: LAYER2,
                        fontSize: 11,
                      },
                    },
                    h(Dot, { tone: bucketTone(bucket.id) }),
                    h('span', { style: { color: LABEL2 } }, bucket.label),
                    h('span', { style: { color: LABEL, fontVariantNumeric: 'tabular-nums' } }, `${bucket.count}`),
                    // 桶内金额全不可得时显示「—」，不用 +0.00 假装是零
                    bucket.pnl_unknown_count === bucket.count && bucket.count > 0
                      ? h(
                          'span',
                          { style: { color: LABEL2 }, title: `该桶 ${bucket.count} 笔的浮动盈亏均不可得` },
                          '金额 —',
                        )
                      : h(
                          'span',
                          { style: { color: pnlColor(bucket.floating_pnl), fontVariantNumeric: 'tabular-nums' } },
                          signedMoney(bucket.floating_pnl),
                        ),
                  ),
                ),
              ),
            ),

        rows.length ? h(LotTable, { rows, view, t }) : h('div', { style: { fontSize: 12, color: LABEL2 } }, t('noRows')),
      )
    }

    // ── 历史战绩 ─────────────────────────────────────────────
    function StatsSection({ board, t }) {
      const stats = board?.stats
      if (!stats) return null
      const byType = stats.by_trade_type ?? {}
      const typeRows = [
        [t('regular'), byType.regular_swing],
        [t('nativeT0'), byType.native_t0],
        [t('coreSub'), byType.core_substitution_t0],
      ]
      const bySymbol = Object.entries(stats.by_symbol ?? {}).sort(
        (a, b) => num(b[1]?.total_realized_pnl) - num(a[1]?.total_realized_pnl),
      )
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, color: LABEL } }, t('stats')),
        h(
          Card,
          { style: { display: 'flex', gap: '14px 28px', flexWrap: 'wrap' } },
          h(Stat, { label: t('totalTrades'), value: `${stats.total_trades ?? 0} ${t('trades')}` }),
          h(Stat, { label: t('winRate'), value: pct(stats.win_rate), tone: pnlColor(num(stats.win_rate) - 0.5) }),
          h(Stat, {
            label: t('realized'),
            value: `${signedMoney(stats.total_realized_pnl)} 元`,
            tone: pnlColor(stats.total_realized_pnl),
          }),
          h(Stat, { label: t('profitFactor'), value: num(stats.profit_factor).toFixed(2) }),
          h(Stat, { label: t('dayTrades'), value: String(stats.day_trades_count ?? 0) }),
        ),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 } },
          h(
            Card,
            null,
            h('div', { style: { fontSize: 12, color: LABEL2, marginBottom: 6 } }, t('byType')),
            h(
              'table',
              { style: { borderCollapse: 'collapse', width: '100%' } },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h(Th, null, ''),
                  h(Th, { align: 'right' }, t('totalTrades')),
                  h(Th, { align: 'right' }, t('winRate')),
                  h(Th, { align: 'right' }, t('realized')),
                ),
              ),
              h(
                'tbody',
                null,
                typeRows.map(([label, row]) =>
                  h(
                    'tr',
                    { key: label },
                    Td({ children: label }),
                    Td({ children: String(row?.total_trades ?? 0), align: 'right' }),
                    Td({ children: pct(row?.win_rate ?? 0), align: 'right', tone: pnlColor(num(row?.win_rate) - 0.5) }),
                    Td({
                      children: signedMoney(row?.total_realized_pnl ?? 0),
                      align: 'right',
                      tone: pnlColor(row?.total_realized_pnl),
                    }),
                  ),
                ),
              ),
            ),
          ),
          bySymbol.length
            ? h(
                Card,
                null,
                h('div', { style: { fontSize: 12, color: LABEL2, marginBottom: 6 } }, t('bySymbol')),
                h(
                  'div',
                  { style: { maxHeight: 220, overflowY: 'auto' } },
                  h(
                    'table',
                    { style: { borderCollapse: 'collapse', width: '100%' } },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h(Th, null, t('symbol')),
                        h(Th, { align: 'right' }, t('totalTrades')),
                        h(Th, { align: 'right' }, t('winRate')),
                        h(Th, { align: 'right' }, t('realized')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      bySymbol.map(([symbol, row]) =>
                        h(
                          'tr',
                          { key: symbol },
                          Td({ children: symbol }),
                          Td({ children: String(row?.total_trades ?? 0), align: 'right' }),
                          Td({ children: pct(row?.win_rate ?? 0), align: 'right', tone: pnlColor(num(row?.win_rate) - 0.5) }),
                          Td({
                            children: signedMoney(row?.total_realized_pnl ?? 0),
                            align: 'right',
                            tone: pnlColor(row?.total_realized_pnl),
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : null,
        ),
      )
    }

    // ── 主面板 (main) ────────────────────────────────────────
    function LotTraderBoard({ t }) {
      const { snapshot, failed, busy, recompute } = useSnapshot()
      const board = snapshot?.board ?? null
      const degraded = Boolean(snapshot?.degraded)
      const [expandedSymbols, setExpandedSymbols] = useState(new Set())
      const toggleSymbol = useCallback((symbol) => {
        setExpandedSymbols((prev) => {
          const next = new Set(prev)
          if (next.has(symbol)) next.delete(symbol)
          else next.add(symbol)
          return next
        })
      }, [])
      const lotsBySymbol = useMemo(() => {
        const map = {}
        if (!board) return map
        for (const lot of board.lotsByTime ?? []) {
          if (!map[lot.symbol]) map[lot.symbol] = { time: [], ret: [] }
          map[lot.symbol].time.push(lot)
        }
        for (const lot of board.lotsByReturn ?? []) {
          if (!map[lot.symbol]) map[lot.symbol] = { time: [], ret: [] }
          map[lot.symbol].ret.push(lot)
        }
        return map
      }, [board])

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            boxSizing: 'border-box',
            padding: '18px 22px 40px',
            background: 'var(--dsw-alias-bg-base)',
            color: LABEL,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          },
        },
        // 顶栏
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 16, fontWeight: 600 } }, t('title')),
          h(Dot, { tone: failed ? RED : degraded ? WARN : snapshot?.refreshing ? BRAND : GREEN }),
          h(
            'span',
            { style: { fontSize: 11, color: LABEL2 } },
            failed
              ? `${t('failed')}: ${failed}`
              : snapshot?.generatedAt
                ? `${t('updated')} ${clockTime(snapshot.generatedAt)}${snapshot.refreshing ? ' · 后台重算中' : ''}`
                : t('loading'),
          ),
          h('div', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              onClick: recompute,
              disabled: busy,
              style: {
                padding: '4px 12px',
                border: `1px solid ${BORDER}`,
                borderRadius: 6,
                background: 'transparent',
                color: LABEL2,
                fontSize: 12,
                font: 'inherit',
                cursor: busy ? 'default' : 'pointer',
              },
            },
            busy ? t('refreshing') : t('refresh'),
          ),
        ),

        // 引擎/账本溯源（出问题时第一眼要看的就是它到底连的是哪个二进制、哪个库）
        snapshot?.engine
          ? h(
              'div',
              { style: { fontSize: 11, color: LABEL2, display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h('span', null, `${t('engine')} ${snapshot.engine.binary} (${snapshot.engine.binary_source})`),
              h('span', null, `${t('ledger')} ${snapshot.engine.db} (${snapshot.engine.db_source})`),
              snapshot.engine.approval_required_for_writes
                ? h('span', { style: { color: WARN } }, '写操作需审批')
                : null,
              // 自动下载状态必须如实显示：正在拉、拉完了、拉失败，都不许悄悄咽掉。
              snapshot.engine.binary_status === 'downloading'
                ? h('span', { style: { color: BRAND } }, `⟳ 正在下载引擎 ${snapshot.engine.platform_target ?? ''}…`)
                : snapshot.engine.binary_status === 'failed'
                  ? h(
                      'span',
                      { style: { color: RED }, title: snapshot.engine.binary_error ?? '' },
                      `✕ 引擎不可用：${String(snapshot.engine.binary_error ?? '未知原因').slice(0, 90)}`,
                    )
                  : null,
            )
          : null,

        degraded
          ? h(
              'div',
              {
                style: {
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: `1px solid ${WARN}`,
                  background: LAYER2,
                  color: WARN,
                  fontSize: 12,
                },
              },
              `⚠ ${snapshot?.degraded_reason ?? ''}${snapshot?.error ? ` — ${snapshot.error}` : ''}`,
            )
          : null,

        !board
          ? h('div', { style: { color: LABEL2, fontSize: 12 } }, failed ? `${t('failed')}: ${failed}` : t('loading'))
          : h(
              React.Fragment,
              null,
              h(SummarySection, { board, t }),
              h('div', { style: { fontSize: 13, fontWeight: 600, color: LABEL } }, t('symbolsTitle')),
              h(
                'div',
                {
                  style: {
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
                    gap: 12,
                  },
                },
                (board.symbols ?? []).map((target) => {
                  const symLots = lotsBySymbol[target.symbol]
                  return h(SymbolCard, {
                    key: target.symbol, target, t,
                    expanded: expandedSymbols.has(target.symbol),
                    onToggle: () => toggleSymbol(target.symbol),
                    symbolLotsTime: symLots?.time ?? [],
                    symbolLotsReturn: symLots?.ret ?? [],
                  })
                }),
              ),
              h(LotSection, { board, t }),
              h(StatsSection, { board, t }),
            ),
      )
    }

    return {
      inject: ['slots'],
      /**
       * 纯函数出口，仅供单测。
       *
       * 数值格式化是「数据诚实」的最后一道闸：deriveBoard 把未知保持成 null 之后，
       * 只要渲染层再把它压回 0，前面全白做。这些函数没有副作用、不依赖 React，
       * 放在这里让 node 侧能直接验，而不是只能靠读源码正则「守」。
       */
      __test: { isUnknown, rateOf, money, pct, signedMoney, pnlColor },
      apply(ctx) {
        // 文案走 Client locale 服务；缺席时用内置词典兜底。
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale
        let t = (key) => ZH[key] ?? key
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => locale.register('lot-trader', 'zh', ZH))
          ctx.effect(() => locale.register('lot-trader', 'en', EN))
          if (typeof locale.bind === 'function') t = locale.bind('lot-trader')
        }

        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return

        // 左侧栏图标：id 与 main 的 key 必须一致，owner 靠它把图标与面板配对。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'lot-trader', order: 30, label: () => t('title') },
            LotTraderIcon,
          ),
        )

        // 中央主视口面板。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'lot-trader' }, () => h(LotTraderBoard, { t })),
        )
      },
    }
  },
})
