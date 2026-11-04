/**
 * lot-trader DSH 插件 · Host 半边契约测试。
 *
 * 只测**纯逻辑与真实的进程行为**，不 mock CLI：
 *   - 路径解析 / 配置归一 / 宽容 JSON 解析；
 *   - 看板派生：两个批次视图必须真的独立排序，不是同一个数组；
 *   - createCliRunner 打真进程：脚本真吐 JSON、真退出非零、二进制真不存在，
 *     三条路径都必须如实归类，不许把「没解析到」当成「成功」。
 *
 * 运行：node --test test/*.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RETURN_BUCKETS,
  TOOL_NAMES,
  TradeCliError,
  UNKNOWN_BUCKET_ID,
  WRITE_TOOLS,
  bunBuildTarget,
  createCliRunner,
  createTradeTools,
  deriveBoard,
  downloadBinary,
  expandHome,
  isExecutableFile,
  normalizeConfig,
  parseJsonLoose,
  platformTarget,
  readBodyWithStallWatchdog,
  resolveBinary,
  resolveDbPath,
  runOrThrow,
  stripLots,
  toFiniteNumber,
  toPositiveNumber,
} from '../tools.js'

import {
  authorizeRequest,
  decideApproval,
  describeCapWarning,
  describeWrite,
  isLoopbackRequest,
  renderDiscipline,
  writeJson,
} from '../index.js'

/** 造一个可执行的 shell 脚本，用来当受控的假 CLI。 */
function fakeBinary(body) {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-test-'))
  const file = join(dir, 'fake-trade')
  writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(file, 0o755)
  return file
}

// ─────────────────────────────────────────────── 路径与配置

test('expandHome 展开 ~，并把空/非字符串当「没配」', () => {
  assert.match(expandHome('~/x'), /\/x$/)
  assert.ok(!expandHome('~/x').includes('~'))
  assert.equal(expandHome(''), '')
  assert.equal(expandHome('   '), '')
  assert.equal(expandHome(undefined), '')
  assert.equal(expandHome(null), '')
  assert.equal(expandHome(42), '')
  assert.equal(expandHome('/abs/path'), '/abs/path')
})

test('resolveBinary：配了且存在就用配置的；不存在时如实记进 tried', () => {
  const exists = fakeBinary('exit 0')
  const hit = resolveBinary(exists)
  assert.equal(hit.path, exists)
  assert.equal(hit.source, 'config.binaryPath')

  const miss = resolveBinary('/definitely/not/here/trade')
  assert.ok(miss.tried.includes('/definitely/not/here/trade'))
  // 落到回退链的某一环，但绝不能假装就是那个不存在的路径
  assert.notEqual(miss.path, '/definitely/not/here/trade')
})

test('resolveDbPath：config > 环境变量 > 默认账本', () => {
  const saved = { a: process.env.LOT_TRADER_DB, b: process.env.TRADE_DB_PATH }
  try {
    delete process.env.LOT_TRADER_DB
    delete process.env.TRADE_DB_PATH

    assert.equal(resolveDbPath('/explicit.db').path, '/explicit.db')
    assert.equal(resolveDbPath('/explicit.db').source, 'config.dbPath')

    const fallback = resolveDbPath('')
    assert.match(fallback.path, /\.trade\/trade\.db$/)
    assert.equal(fallback.source, '~/.trade/trade.db')

    process.env.LOT_TRADER_DB = '/env/ledger.db'
    assert.equal(resolveDbPath('').path, '/env/ledger.db')
    assert.equal(resolveDbPath('').source, '$LOT_TRADER_DB')

    delete process.env.LOT_TRADER_DB
    process.env.TRADE_DB_PATH = '/legacy/ledger.db'
    assert.equal(resolveDbPath('').path, '/legacy/ledger.db')
    assert.equal(resolveDbPath('').source, '$TRADE_DB_PATH')

    // config 永远压过环境变量
    assert.equal(resolveDbPath('/explicit.db').path, '/explicit.db')
  } finally {
    if (saved.a === undefined) delete process.env.LOT_TRADER_DB
    else process.env.LOT_TRADER_DB = saved.a
    if (saved.b === undefined) delete process.env.TRADE_DB_PATH
    else process.env.TRADE_DB_PATH = saved.b
  }
})

test('normalizeConfig 补齐默认值，并给轮询间隔设下限', () => {
  const d = normalizeConfig()
  assert.equal(d.pollMs, 45_000)
  assert.equal(d.requireApprovalForWrites, true)
  assert.equal(d.disciplineOrder, 170)
  assert.equal(d.cap, 0)

  // 5 秒被抬到下限 15 秒；不能出现亚秒级轰炸
  assert.equal(normalizeConfig({ pollSeconds: 5 }).pollMs, 15_000)
  assert.equal(normalizeConfig({ pollSeconds: 60 }).pollMs, 60_000)

  // 只有显式 false 才关审批
  assert.equal(normalizeConfig({ requireApprovalForWrites: false }).requireApprovalForWrites, false)
  assert.equal(normalizeConfig({ requireApprovalForWrites: 0 }).requireApprovalForWrites, true)

  // 非正数 cap 视为未配置
  assert.equal(normalizeConfig({ cap: -1 }).cap, 0)
  assert.equal(normalizeConfig({ cap: 80_000 }).cap, 80_000)
})

// ─────────────────────────────────────────────── JSON 解析

test('parseJsonLoose：纯 JSON / 混入堆栈的 JSON / 垃圾输入', () => {
  assert.deepEqual(parseJsonLoose('{"code":0}'), { code: 0 })
  assert.deepEqual(
    parseJsonLoose('SQLiteError: boom\n    at initSchema\n{"code":1,"msg":"readonly"}'),
    { code: 1, msg: 'readonly' },
  )
  assert.equal(parseJsonLoose(''), undefined)
  assert.equal(parseJsonLoose('   '), undefined)
  assert.equal(parseJsonLoose('not json at all'), undefined)
  assert.equal(parseJsonLoose('{ broken'), undefined)
})

// ─────────────────────────────────────────────── CLI 执行器

test('createCliRunner：成功路径解析出 data，并把 --json/--db 真的传下去', async () => {
  // 假 CLI 把收到的 argv 回显进 data，用来证明两个全局参数确实在命令行上
  const binary = fakeBinary('echo "{\\"code\\":0,\\"msg\\":\\"success\\",\\"data\\":{\\"argv\\":\\"$*\\"}}"')
  const run = createCliRunner({ binary, dbPath: '/tmp/x.db' })
  const result = await run(['position', '--symbol', '518880'])

  assert.equal(result.ok, true)
  assert.ok(result.argv.includes('--json'))
  assert.ok(result.argv.includes('--db'))
  assert.ok(result.argv.includes('/tmp/x.db'))
  assert.match(String(result.data.argv), /--json/)
  assert.match(String(result.data.argv), /--db \/tmp\/x\.db/)
})

test('createCliRunner：CLI 返回非零 code 时如实归类，绝不返回 ok', async () => {
  const binary = fakeBinary('echo "{\\"code\\":1,\\"msg\\":\\"单标的仓位超 30% 硬顶\\"}"\nexit 1')
  const run = createCliRunner({ binary, dbPath: '/tmp/x.db' })
  const result = await run(['lot', 'buy'])

  assert.equal(result.ok, false)
  assert.equal(result.code, 'CLI_CODE_1')
  assert.match(result.message, /30% 硬顶/)

  await assert.rejects(
    () => runOrThrow(run, ['lot', 'buy'], 'trade lot buy'),
    (error) => {
      assert.ok(error instanceof TradeCliError)
      assert.match(error.message, /trade lot buy 失败/)
      assert.match(error.message, /30% 硬顶/)
      return true
    },
  )
})

test('createCliRunner：非 JSON 输出判 CLI_NO_JSON，而不是当成空数据成功', async () => {
  const binary = fakeBinary('echo "usage: trade ..."')
  const run = createCliRunner({ binary, dbPath: '/tmp/x.db' })
  const result = await run(['position'])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CLI_NO_JSON')
})

test('createCliRunner：二进制不存在判 CLI_NOT_FOUND，绝不静默成功', async () => {
  const run = createCliRunner({ binary: '/definitely/not/here/fake-trade', dbPath: '/tmp/x.db' })
  const result = await run(['position'])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CLI_NOT_FOUND')
})

// ─────────────────────────────────────────────── 工具表

test('工具表：名字唯一、数量正确，且写工具集合是子集', () => {
  const run = async () => ({ ok: true, data: {} })
  const tools = createTradeTools({ run, getCap: () => 50_000 })
  const names = tools.map((tool) => tool.name)

  assert.equal(new Set(names).size, names.length, '工具名不能重复')
  assert.equal(tools.length, 11)
  assert.equal(Object.keys(TOOL_NAMES).length, 11)

  for (const write of WRITE_TOOLS) {
    assert.ok(names.includes(write), `写工具 ${write} 必须在注册表里`)
  }
  // 写集合必须是真子集：读工具不该被审批闸门误伤
  assert.ok(WRITE_TOOLS.length < names.length)
  assert.ok(!WRITE_TOOLS.includes(TOOL_NAMES.position))
  assert.ok(!WRITE_TOOLS.includes(TOOL_NAMES.scan))

  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} 必须可执行`)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10, `${tool.name} 的描述要能让模型判断何时调用`)
    assert.equal(tool.output?.schema?.type, 'object')
  }
})

/**
 * 回归防护：`parameters` 会原样作为 JSON Schema 发给模型 API。
 *
 * 曾经这里是一份**裸属性字典**（`{ symbol: { type, required: true } }`）——
 * 缺 `type`/`properties`，且 `required` 塞在属性节点里属于非法位置。
 * 宽容的 provider 能忍，严格的（如 flash 链路）直接报错，表现为「模型一直报错」
 * 而工具本身的 execute 完全正常，极难定位。
 */
/** 插件根目录，供源码守卫类断言读取。 */
const pluginDir = fileURLToPath(new URL('..', import.meta.url))

/**
 * 在 node 里把 client.js 加载出来，取它暴露的纯函数出口。
 *
 * client.js 的宿主契约是 `window.__ModuleLoader__.load({ id, factory })`，
 * 所以这里给一个假 loader + 假 react，把 factory 的返回值截下来。
 * 这样「未知收益率渲染成 —」这件事就是**真的跑过一遍**，
 * 而不是靠读源码正则猜。
 */
function loadClientHelpers() {
  const src = readFileSync(join(pluginDir, 'client.js'), 'utf8')
  const reactStub = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useMemo: (fn) => (typeof fn === 'function' ? fn() : undefined),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => undefined],
  }

  let captured = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          assert.equal(definition.id, '@goodfun-studio/lot-trader'.replace('lot-trader', 'dsh-lot-trader'))
          captured = definition.factory((name) => {
            if (name === 'react') return reactStub
            throw new Error(`client.js 请求了未预期的模块：${name}`)
          })
        },
      },
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
  assert.ok(captured.__test, 'client.js 必须暴露 __test 纯函数出口供单测使用')
  return captured
}

test('每个工具的 parameters 都是合法 JSON Schema', () => {
  const run = async () => ({ ok: true, data: {} })
  const tools = createTradeTools({ run, getCap: () => 50_000 })

  for (const tool of tools) {
    const p = tool.parameters
    assert.equal(p?.type, 'object', `${tool.name}: parameters.type 必须是 "object"`)
    assert.ok(
      p && typeof p.properties === 'object' && !Array.isArray(p.properties),
      `${tool.name}: parameters.properties 必须是对象`,
    )

    // required 只能出现在 schema 顶层，且必须是字符串数组
    if (p.required !== undefined) {
      assert.ok(Array.isArray(p.required), `${tool.name}: required 必须是数组`)
      for (const key of p.required) {
        assert.equal(typeof key, 'string', `${tool.name}: required 元素必须是字符串`)
        assert.ok(key in p.properties, `${tool.name}: required 里的 ${key} 必须在 properties 里`)
      }
    }

    // 负向：属性节点里不得残留 required 布尔值（对象层也不能留 undefined 脏键）
    for (const [key, node] of Object.entries(p.properties ?? {})) {
      assert.ok(!('required' in node), `${tool.name}.${key}: 属性节点里不该有 required 键`)
      assert.equal(typeof node.type, 'string', `${tool.name}.${key}: 每个属性都要有 type`)
    }

    // JSON 往返后结构不变：保证发到 API 的就是我们看到的
    const roundTripped = JSON.parse(JSON.stringify(p))
    assert.deepEqual(roundTripped, p, `${tool.name}: parameters 必须能无损 JSON 序列化`)
  }
})

test('trade_position 默认剥掉逐笔批次，include_lots 才内联', async () => {
  const view = {
    portfolio_summary: { total_active_lots: 1 },
    targets: [{ symbol: '518880.SH', lots: [{ lot_id: 'L1' }, { lot_id: 'L2' }] }],
  }
  const run = async () => ({ ok: true, data: view })
  const tools = createTradeTools({ run, getCap: () => 50_000 })
  const position = tools.find((tool) => tool.name === TOOL_NAMES.position)

  const slim = await position.execute({})
  assert.equal(slim.targets[0].lots, undefined, '默认不该把上百笔批次塞进上下文')
  assert.equal(slim.targets[0].lots_count, 2)

  const full = await position.execute({ include_lots: true })
  assert.equal(full.targets[0].lots.length, 2)
})

test('trade_lot_list 在插件侧排序与分页，且 status 无条件透传', async () => {
  const rows = [
    { lot_id: 'A', buy_time: '2026-01-01T00:00:00Z', return_rate: 0.05 },
    { lot_id: 'B', buy_time: '2026-03-01T00:00:00Z', return_rate: -0.2 },
    { lot_id: 'C', buy_time: '2026-02-01T00:00:00Z', return_rate: 0.31 },
  ]
  const seen = []
  const run = async (argv) => {
    seen.push(argv)
    return { ok: true, data: rows }
  }
  const tools = createTradeTools({ run, getCap: () => 0 })
  const list = tools.find((tool) => tool.name === TOOL_NAMES.lotList)
  const statusOf = (argv) => (argv.includes('--status') ? argv[argv.indexOf('--status') + 1] : null)

  const byTime = await list.execute({})
  assert.deepEqual(byTime.rows.map((row) => row.lot_id), ['B', 'C', 'A'], '默认按买入时间倒序')
  assert.equal(statusOf(seen[0]), 'ACTIVE', '不传时明确落到 ACTIVE')

  const byReturn = await list.execute({ sort_by: 'return_rate', limit: 2 })
  assert.deepEqual(byReturn.rows.map((row) => row.lot_id), ['C', 'A'])
  assert.equal(byReturn.total, 3)
  assert.equal(byReturn.returned, 2)

  const paged = await list.execute({ sort_by: 'return_rate', limit: 1, offset: 2 })
  assert.deepEqual(paged.rows.map((row) => row.lot_id), ['B'])

  // 引擎的 `--status` 声明默认值就是 ACTIVE，所以「不带 flag」= 只取 ACTIVE。
  // 曾经在 ALL 时刻意不带 flag，导致 `status:'ALL'` 静默返回 ACTIVE-only ——
  // 模型会拿到错误的完整性结论。这里锁的是「ALL 必须真的传到引擎」。
  const all = await list.execute({ status: 'ALL' })
  assert.equal(all.total, 3)
  assert.equal(statusOf(seen.at(-1)), 'ALL', 'ALL 必须透传给引擎，否则等于只查 ACTIVE')

  const closed = await list.execute({ status: 'CLOSED' })
  assert.equal(closed.total, 3)
  assert.equal(statusOf(seen.at(-1)), 'CLOSED')
})

test('写工具成功后触发 onMutate，读工具不触发', async () => {
  let mutations = 0
  const run = async () => ({ ok: true, data: { lot_id: 'L9' } })
  const tools = createTradeTools({
    run,
    getCap: () => 0,
    onMutate: () => {
      mutations += 1
    },
  })

  await tools.find((tool) => tool.name === TOOL_NAMES.position).execute({})
  assert.equal(mutations, 0, '读命令不该让看板快照失效')

  await tools.find((tool) => tool.name === TOOL_NAMES.lotBuy).execute({ symbol: '518880', price: 6.1, qty: 100 })
  assert.equal(mutations, 1)

  // onMutate 自己抛错，不能把一次已经落库的成交变成工具错误
  const fragile = createTradeTools({
    run,
    getCap: () => 0,
    onMutate: () => {
      throw new Error('快照刷新炸了')
    },
  })
  const result = await fragile.find((tool) => tool.name === TOOL_NAMES.lotBuy).execute({ symbol: 'X', price: 1, qty: 100 })
  assert.equal(result.lot_id, 'L9')
})

test('trade_physics 缺 symbol 时明确抛错，不拼出残缺 argv', async () => {
  const tools = createTradeTools({ run: async () => ({ ok: true, data: {} }), getCap: () => 0 })
  const physics = tools.find((tool) => tool.name === TOOL_NAMES.physics)
  await assert.rejects(() => physics.execute({}), (error) => {
    assert.equal(error.code, 'E_MISSING_SYMBOL')
    return true
  })
})

// ─────────────────────────────────────────────── 看板派生

test('stripLots 摘掉批次但如实报出数量', () => {
  const out = stripLots({ symbol: 'X', lots: [1, 2, 3] })
  assert.equal(out.lots, undefined)
  assert.equal(out.lots_count, 3)
  assert.equal(out.symbol, 'X')
  assert.equal(stripLots({ symbol: 'Y' }).lots_count, 0)
})

test('deriveBoard：两个批次视图是独立数组，各自真的排好序', () => {
  const position = {
    portfolio_summary: { total_active_lots: 3, total_cost: 300, full_position_cap: 50_000 },
    targets: [
      {
        symbol: '518880.SH',
        name: '黄金ETF华安',
        asset_class: 'ETF',
        portfolio_weight: 0.4,
        lots: [
          { lot_id: 'A', buy_time: '2026-01-01T00:00:00Z', return_rate: 0.05, current_price: 6, remaining_quantity: 100 },
          { lot_id: 'B', buy_time: '2026-03-01T00:00:00Z', return_rate: -0.25, current_price: 6, remaining_quantity: 100 },
        ],
      },
      {
        symbol: '600519.SH',
        name: '贵州茅台',
        asset_class: 'STOCK',
        portfolio_weight: 0.6,
        lots: [
          { lot_id: 'C', buy_time: '2026-02-01T00:00:00Z', return_rate: 0.31, current_price: 1600, remaining_quantity: 10 },
          { lot_id: 'D', buy_time: '2026-01-15T00:00:00Z', return_rate: 0.15, current_price: 1600, remaining_quantity: 10 },
        ],
      },
    ],
  }
  const board = deriveBoard(position, { total_trades: 7 })

  assert.equal(board.lots_count, 4)
  assert.equal(board.symbols.length, 2)
  assert.equal(board.symbols[0].lots, undefined, '标的卡不该内联批次')

  assert.deepEqual(board.lotsByTime.map((l) => l.lot_id), ['B', 'C', 'D', 'A'])
  assert.deepEqual(board.lotsByReturn.map((l) => l.lot_id), ['C', 'D', 'A', 'B'])

  // 两个视图必须是各自独立的数组对象，改一个不能串到另一个
  assert.notEqual(board.lotsByTime, board.lotsByReturn)
  board.lotsByTime.push({ lot_id: 'ZZZ' })
  assert.equal(board.lotsByReturn.length, 4, '两个视图不能共享同一个数组')

  // 派生字段
  const b = board.lotsByReturn.find((l) => l.lot_id === 'B')
  assert.equal(b.bucket, 'deep-value')
  assert.equal(b.market_value, 600)
  assert.equal(b.symbol_name, '黄金ETF华安')
  assert.equal(b.asset_class, 'ETF')

  // 分层透视：RETURN_BUCKETS 六个盈亏档 + 一个「收益率不可用」桶
  assert.equal(board.bucketCounts.length, RETURN_BUCKETS.length + 1)
  assert.equal(board.bucketCounts.reduce((sum, bucket) => sum + bucket.count, 0), 4)
  const bucketOf = (id) => board.bucketCounts.find((bucket) => bucket.id === id).count
  assert.equal(bucketOf('deep-value'), 1, 'B 的 -25% 必须落进深度击球区')
  assert.equal(bucketOf('flat'), 1, 'A 的 +5% 必须落进成本线附近')
  assert.equal(bucketOf('take-profit'), 1, 'D 的 +15% 必须落进止盈梯队')
  assert.equal(bucketOf('peak'), 1, 'C 的 +31% 必须落进高位浮盈梯队')
  assert.equal(bucketOf('dip'), 0)
  assert.equal(bucketOf('pullback'), 0)
  assert.equal(bucketOf(UNKNOWN_BUCKET_ID), 0, '本组数据收益率都可得')
  assert.equal(board.rate_unknown_count, 0)
  assert.equal(board.stats.total_trades, 7)
})

test('deriveBoard：收益率未知时保持未知，绝不当成 0（数据诚实）', () => {
  // 现价取不到 → 引擎给的 return_rate 会缺失/非法。曾经 numeric() 把它归零，
  // 于是这批会被塞进「成本线附近 (0 ~ +10%)」——看板上看起来「不赚不亏」，
  // 而事实是「不知道」。这条锁住「未知就该显示为未知」。
  const board = deriveBoard(
    {
      targets: [
        {
          symbol: 'X',
          // 真引擎总会给出 name（解析到就用名字，解析不到就退化成代码本身）。
          // 这里必须给一个已解析的名字，否则会走「引擎不认识的标的」那条分支。
          name: '测试标的',
          lots: [
            { lot_id: 'UNKNOWN', buy_time: '2026-01-01T00:00:00Z', return_rate: 'n/a', current_price: null, remaining_quantity: 100 },
            { lot_id: 'KNOWN', buy_time: '2026-01-02T00:00:00Z', return_rate: 0.05, current_price: 10, remaining_quantity: 100 },
          ],
        },
      ],
    },
    null,
  )

  const unknown = board.lotsByReturn.find((l) => l.lot_id === 'UNKNOWN')
  assert.equal(unknown.return_rate, null, '收益率必须保持 null，不能变成 0')
  assert.equal(unknown.rate_known, false)
  assert.equal(unknown.bucket, UNKNOWN_BUCKET_ID, '必须落到「收益率不可用」桶，而不是成本线附近')
  assert.equal(unknown.market_value, null, '市值算不出就保持 null，不假装是 0')

  // 未知值排到最后，不能插进「不赚不亏」的位置
  assert.deepEqual(board.lotsByReturn.map((l) => l.lot_id), ['KNOWN', 'UNKNOWN'])

  const bucketOf = (id) => board.bucketCounts.find((bucket) => bucket.id === id).count
  assert.equal(bucketOf('flat'), 1, '只有真正 +5% 的那笔进成本线附近')
  assert.equal(bucketOf(UNKNOWN_BUCKET_ID), 1)
  assert.equal(board.rate_unknown_count, 1)

  const unknownBucket = board.bucketCounts.find((b) => b.id === UNKNOWN_BUCKET_ID)
  assert.equal(unknownBucket.pnl_unknown_count, 1, '桶内金额不可得的笔数要如实报出')
})

test('deriveBoard：空账本不产生 NaN', () => {
  const empty = deriveBoard(undefined, undefined)
  assert.equal(empty.lots_count, 0)
  assert.deepEqual(empty.lotsByTime, [])
  assert.equal(empty.portfolio, null)
  assert.equal(empty.rate_unknown_count, 0)
})

// ─────────────────────────────────────────────── 纪律与审批

test('renderDiscipline 把八条操盘纪律逐条讲清', () => {
  const text = renderDiscipline({ binary: '/x/trade', db: '/y/trade.db', cap: 50_000 })
  for (const needle of ['30%', '48 小时', '-20%', 'bash', '审批', 'ACTIVE', '同一 (标的, 账户)']) {
    assert.ok(text.includes(needle), `纪律切片应包含「${needle}」`)
  }
  assert.ok(text.includes('/y/trade.db'), '纪律切片要写明实际账本路径')
  assert.ok(text.includes('/x/trade'), '纪律切片要写明实际二进制')
})

test('describeWrite 把写操作压成看得懂的一句话', () => {
  assert.match(
    describeWrite(TOOL_NAMES.lotBuy, { symbol: '518880.SH', qty: 2000, price: 6.12, account: 'CMB' }),
    /买入 518880\.SH 2000 股 @ 6\.12 \[CMB\]/,
  )
  assert.match(describeWrite(TOOL_NAMES.lotClose, { lot_id: 'LOT-1', price: 7.05, substitute_core: true }), /平仓 LOT-1 .*底仓代冲/)
  assert.match(describeWrite(TOOL_NAMES.accountAdd, { account_id: 'CMB_MAIN' }), /登记账户 CMB_MAIN/)
})

test('describeWrite 字段缺失时附上原始入参，不让用户对着 ? 点头', () => {
  // 关键字段缺失时摘要里必然出现 '?'。曾经就到此为止（`买入 ? ? 股 @ ?`），
  // 用户可能因此批准一笔自己没看清的订单 —— 审批提示必须始终说明「要干什么」。
  const partial = describeWrite(TOOL_NAMES.lotBuy, { symbol: '518880.SH' })
  assert.match(partial, /\?/, '摘要本身仍会暴露缺失字段')
  assert.match(partial, /原始入参/, '必须补上原始入参')
  assert.match(partial, /518880\.SH/, '原始入参里要能看见模型实际传了什么')

  // 认不出工具名时也要有用，而不是把工具名原样丢回给用户
  const unknown = describeWrite('something_else', { foo: 1 })
  assert.match(unknown, /未知写操作 something_else/)
  assert.match(unknown, /foo/, '原始入参要在')
})

test('isLoopbackRequest 只放回环，拒绝同网段，且拿不到地址时拒绝', () => {
  const req = (remoteAddress, host) => ({ socket: { remoteAddress }, headers: host ? { host } : {} })

  assert.equal(isLoopbackRequest(req('127.0.0.1', '127.0.0.1:8080')), true)
  assert.equal(isLoopbackRequest(req('::1', 'localhost:8080')), true)
  assert.equal(isLoopbackRequest(req('::ffff:127.0.0.1', '[::1]:8080')), true)

  // 负向防误杀：非回环一律拒
  assert.equal(isLoopbackRequest(req('192.168.1.9', '192.168.1.9:8080')), false)
  assert.equal(isLoopbackRequest(req('10.0.0.3', undefined)), false)
  assert.equal(isLoopbackRequest(req('127.0.0.1', 'evil.example.com')), false)

  // 拿不到 socket 地址时也拒绝：真实浏览器请求一定带地址，
  // 取不到说明不是走正常 TCP 回环进来的。曾经这里放行，与「两道闸缺一不可」矛盾。
  assert.equal(isLoopbackRequest(req(undefined, '127.0.0.1:8080')), false, '地址缺失必须拒绝')
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:8080' } }), false, '没有 socket 必须拒绝')
})

// ─────────────────────────────────────────────── 自动下载与平台映射

test('platformTarget 按平台映射，且只返回发布矩阵里真实存在的产物', () => {
  // 显式传平台，覆盖所有分支而不必换机器
  assert.equal(platformTarget('darwin', 'arm64'), 'trade-darwin-arm64')
  assert.equal(platformTarget('darwin', 'x64'), 'trade-darwin-x64')
  assert.equal(platformTarget('linux', 'x64'), 'trade-linux-x64')
  assert.equal(platformTarget('linux', 'arm64'), 'trade-linux-arm64')

  // Windows 没有发布产物 → 必须返回 null，让调用方立刻报「未预编译平台」，
  // 而不是编一个不存在的名字走完整条下载流程再收到网络类错误。
  assert.equal(platformTarget('win32', 'x64'), null, 'Windows 无产物必须返回 null')
  assert.equal(platformTarget('win32', 'arm64'), null)
  assert.equal(platformTarget('freebsd', 'x64'), null)

  // 默认参数取当前运行时
  assert.equal(platformTarget(), platformTarget(process.platform, process.arch))
})

test('bunBuildTarget 生成合法的 Bun 编译 target', () => {
  assert.equal(bunBuildTarget('darwin', 'arm64'), 'bun-darwin-arm64')
  assert.equal(bunBuildTarget('darwin', 'x64'), 'bun-darwin-x64')
  assert.equal(bunBuildTarget('linux', 'x64'), 'bun-linux-x64')
  assert.equal(bunBuildTarget('linux', 'arm64'), 'bun-linux-arm64')
  // Windows 在 Bun 里叫 windows 而不是 win32
  assert.equal(bunBuildTarget('win32', 'x64'), 'bun-windows-x64')
})

test('normalizeConfig 的 autoDownload 默认开，只有显式 false 才关', () => {
  assert.equal(normalizeConfig().autoDownload, true)
  assert.equal(normalizeConfig({}).autoDownload, true)
  assert.equal(normalizeConfig({ autoDownload: false }).autoDownload, false)
  // 0 / '' / null 都不该被当成显式关闭
  assert.equal(normalizeConfig({ autoDownload: 0 }).autoDownload, true)
  assert.equal(normalizeConfig({ autoDownload: null }).autoDownload, true)
})

test('downloadBinary 在未预编译平台上明确失败', async () => {
  const target = platformTarget()
  if (target !== null) return // 当前平台有预编译产物，此断言不适用
  await assert.rejects(() => downloadBinary(), /没有为 .* 预编译的 trade 二进制/)
})

test('createCliRunner 支持动态二进制：切换后下一次调用立刻用新路径', async () => {
  let current = fakeBinary('echo "{\\"code\\":0,\\"msg\\":\\"success\\",\\"data\\":{\\"from\\":\\"first\\"}}"')
  const run = createCliRunner({ binary: () => current, dbPath: '/tmp/x.db' })

  const first = await run(['position'])
  assert.equal(first.ok, true)
  assert.equal(first.data.from, 'first')

  // 模拟自动下载完成：换成另一个吐不同 data 的假二进制
  current = fakeBinary('echo "{\\"code\\":0,\\"msg\\":\\"success\\",\\"data\\":{\\"from\\":\\"second\\"}}"')
  const second = await run(['position'])
  assert.equal(second.ok, true)
  assert.equal(second.data.from, 'second', 'runner 必须每次重新读路径，不能缓存旧二进制')
})

test('createCliRunner 仍接受普通字符串 binary（向后兼容）', async () => {
  const bin = fakeBinary('echo "{\\"code\\":0,\\"msg\\":\\"success\\",\\"data\\":{\\"ok\\":1}}"')
  const run = createCliRunner({ binary: bin, dbPath: '/tmp/x.db' })
  const result = await run(['stats'])
  assert.equal(result.ok, true)
  assert.equal(result.data.ok, 1)
})

// ─────────────────────────────────────────────── 快照路由准入（安全）

/** 造一个假的 Node 请求对象。 */
function fakeRequest(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers }
}

/** 造一个假的响应对象，记录 writeHead 收到的头。 */
function fakeResponse() {
  const captured = { status: null, headers: null, body: null }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(body) {
      captured.body = body
    },
  }
}

test('authorizeRequest：Connection 缺席时 fail closed，绝不放行', () => {
  const loopback = fakeRequest('127.0.0.1', { host: '127.0.0.1:8080' })

  assert.equal(authorizeRequest({}, loopback), 403, '没有 ctx.get 必须拒绝')
  assert.equal(authorizeRequest({ get: () => undefined }, loopback), 403, '拿不到 connection 必须拒绝')
  assert.equal(authorizeRequest({ get: () => ({}) }, loopback), 403, 'connection 没有 requestRejection 必须拒绝')
  assert.equal(
    authorizeRequest({ get: () => ({ requestRejection: 'nope' }) }, loopback),
    403,
    'requestRejection 不是函数必须拒绝',
  )
})

test('authorizeRequest：物理层先拦非回环，Connection 无权越过', () => {
  // 一个「什么都放行」的 Connection —— 也不该让同网段请求读到账本
  const permissive = { get: () => ({ requestRejection: () => undefined }) }

  assert.equal(authorizeRequest(permissive, fakeRequest('192.168.1.9', { host: '192.168.1.9:8080' })), 403)
  assert.equal(authorizeRequest(permissive, fakeRequest('10.0.0.3', { host: '127.0.0.1:8080' })), 403)
  // Host 头指向外部域名，即便 socket 是回环也拒
  assert.equal(authorizeRequest(permissive, fakeRequest('127.0.0.1', { host: 'evil.example.com' })), 403)
})

test('authorizeRequest：把 Connection 的 401/403 原样透出', () => {
  const loopback = () => fakeRequest('127.0.0.1', { host: '127.0.0.1:8080' })

  assert.equal(authorizeRequest({ get: () => ({ requestRejection: () => undefined }) }, loopback()), null)
  assert.equal(authorizeRequest({ get: () => ({ requestRejection: () => 401 }) }, loopback()), 401)
  assert.equal(authorizeRequest({ get: () => ({ requestRejection: () => 403 }) }, loopback()), 403)
})

test('authorizeRequest：认证链路自身抛错也拒绝，不因「判断不了」而放行', () => {
  const ctx = {
    get: () => ({
      requestRejection: () => {
        throw new Error('connection exploded')
      },
    }),
  }
  assert.equal(authorizeRequest(ctx, fakeRequest('127.0.0.1', { host: '127.0.0.1:8080' })), 403)
})

test('authorizeRequest：请求头必须原样交给 Connection（Origin 检查靠它）', () => {
  let seen = null
  const ctx = {
    get: () => ({
      requestRejection: (req) => {
        seen = req
        return undefined
      },
    }),
  }
  const headers = { host: '127.0.0.1:8080', origin: 'https://evil.example.com' }
  authorizeRequest(ctx, fakeRequest('127.0.0.1', headers))

  assert.ok(seen && seen.headers, '必须把 headers 交给 Connection')
  assert.deepEqual(seen.headers, headers, 'headers 不能被过滤或改写，否则 Origin 检查失效')
})

test('writeJson 不得声明任何 CORS 头（负向防误杀）', () => {
  const res = fakeResponse()
  writeJson(res, 200, { ok: true, value: { secret: '持仓' } })

  const headers = res.captured.headers ?? {}
  for (const key of Object.keys(headers)) {
    assert.ok(
      !key.toLowerCase().startsWith('access-control-'),
      `一旦出现 CORS 头（${key}），任意网页都能读到账本快照`,
    )
  }
  // 正向：正常写了 JSON 与内容类型
  assert.equal(headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(JSON.parse(res.captured.body).ok, true)
})

test('下载校验必须 fail closed：拿不到 sha256 就拒绝安装（回归守卫）', () => {
  const source = readFileSync(new URL('../tools.js', import.meta.url), 'utf8')

  // 正向：拒绝分支必须在
  assert.match(source, /拿不到[\s\S]{0,60}sha256 校验文件[\s\S]{0,40}拒绝安装/, '必须保留 fail-closed 拒绝分支')

  // 负向：不得退回「有校验和才校验、没有就静默放过」的旧写法
  assert.ok(
    !/if \(expectedSha256\) \{\s*\n\s*const actual/.test(source),
    '不得退回 fail-open：校验和取不到时不能继续安装',
  )
})

// ─────────────────────────────────────────────── 审批闸门（纯函数）

test('decideApproval：写工具要审批、读工具放行、关掉审批则全放行', () => {
  const on = { requireApprovalForWrites: true }
  // 写工具 → ask
  for (const name of WRITE_TOOLS) {
    const v = decideApproval({ name, arguments: {} }, on)
    assert.equal(v.decision, 'ask', `${name} 必须走审批`)
    assert.ok(!v.failClosed)
  }
  // 读工具 → next（不能被闸门误伤）
  for (const name of [TOOL_NAMES.position, TOOL_NAMES.lotList, TOOL_NAMES.scan, TOOL_NAMES.stats, TOOL_NAMES.physics, TOOL_NAMES.dividendList]) {
    assert.equal(decideApproval({ name, arguments: {} }, on).decision, 'next', `${name} 不该被拦`)
  }
  // 别人的工具 → next（绝不吞掉别的插件的决策）
  assert.equal(decideApproval({ name: 'read_file', arguments: {} }, on).decision, 'next')
  // 显式关掉 → 全放行
  assert.equal(decideApproval({ name: TOOL_NAMES.lotBuy }, { requireApprovalForWrites: false }).decision, 'next')
})

test('decideApproval：取不到工具名时 fail closed（这是曾经的放行缺口）', () => {
  // 原实现是 `if (!WRITE_TOOLS.includes(exec?.name)) return next()` ——
  // payload 形状漂移（name 取不到）时 includes(undefined) 为 false，于是**放行**。
  // HTTP 层同期的原则却是「判断不了就拒绝」，前后不一致。
  const on = { requireApprovalForWrites: true }
  for (const bad of [{}, { name: undefined }, { name: null }, { name: 123 }, { name: '' }, null]) {
    const v = decideApproval(bad, on)
    assert.equal(v.decision, 'ask', `${JSON.stringify(bad)} 必须按写操作处理`)
    assert.equal(v.failClosed, true, '要标记为 fail-closed，好让调用方打 Warn')
  }
})

// ─────────────────────────────────────────────── 配置容错

test('toPositiveNumber 接受数字字符串，拒绝垃圾', () => {
  assert.equal(toPositiveNumber(300000), 300000)
  assert.equal(toPositiveNumber('300000'), 300000, 'YAML 里加引号的 cap 必须能用')
  assert.equal(toPositiveNumber(' 300000 '), 300000)
  assert.equal(toPositiveNumber(0), undefined, '0 不是「正数」')
  assert.equal(toPositiveNumber(-1), undefined)
  assert.equal(toPositiveNumber('abc'), undefined)
  assert.equal(toPositiveNumber(''), undefined)
  assert.equal(toPositiveNumber(null), undefined)
  assert.equal(toPositiveNumber(undefined), undefined)
  assert.equal(toPositiveNumber(NaN), undefined)
  assert.equal(toPositiveNumber(Infinity), undefined)
})

test('normalizeConfig：字符串 cap 生效，非法值回退并留 Warn', () => {
  // 关键回归：`cap: "300000"` 曾经被静默当成 0（= 沿用引擎默认 50000），
  // 而 README 又强调「必须自己设 cap」，用户以为设了其实没设。
  const quoted = normalizeConfig({ cap: '300000' })
  assert.equal(quoted.cap, 300000)
  assert.deepEqual(quoted.warnings, [])

  const bad = normalizeConfig({ cap: '很多钱' })
  assert.equal(bad.cap, 0)
  assert.equal(bad.warnings.length, 1, '解析不出正数必须留痕，不能静默')
  assert.match(bad.warnings[0], /cap/)

  assert.equal(normalizeConfig({ pollSeconds: '60' }).pollMs, 60_000)
  assert.equal(normalizeConfig({ pollSeconds: 'abc' }).pollMs, 45_000)
  assert.equal(normalizeConfig({ pollSeconds: 'abc' }).warnings.length, 1)

  // 没配就不该有告警（「没配」和「配错了」要分得清）
  assert.deepEqual(normalizeConfig({}).warnings, [])
  assert.deepEqual(normalizeConfig({ cap: 0 }).warnings, [])
})

// ─────────────────────────────────────────────── 二进制探测与落盘

test('isExecutableFile：只认「存在且有可执行位」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-exec-'))
  const exec = join(dir, 'exec')
  const plain = join(dir, 'plain')
  writeFileSync(exec, '#!/bin/sh\nexit 0\n')
  chmodSync(exec, 0o755)
  writeFileSync(plain, 'not executable')
  chmodSync(plain, 0o644)

  assert.equal(isExecutableFile(exec), true)
  assert.equal(isExecutableFile(plain), false, '存在但不可执行不算命中（半截下载文件就长这样）')
  assert.equal(isExecutableFile(join(dir, 'missing')), false)
  assert.equal(isExecutableFile(''), false)
  assert.equal(isExecutableFile(undefined), false)
})

test('resolveBinary：半截的缓存文件不会被当成可用二进制', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-half-'))
  const half = join(dir, 'trade')
  writeFileSync(half, 'partial')  // 存在，但没有可执行位
  chmodSync(half, 0o644)

  const hit = resolveBinary(half)
  assert.notEqual(hit.path, half, '存在但不可执行的文件不该被选中，否则此后永久 EACCES 且不回退')
  assert.ok(hit.tried.includes(half))
})

// ─────────────────────────────────────────────── body 停滞看门狗

test('readBodyWithStallWatchdog：正常流读出完整内容', async () => {
  const payload = Buffer.from('x'.repeat(4096))
  const response = new Response(payload)
  const out = await readBodyWithStallWatchdog(response, { stallMs: 5_000 })
  assert.equal(out.length, 4096)
  assert.equal(out.toString(), payload.toString())
})

test('readBodyWithStallWatchdog：完全停滞必须报错，不能永久挂住', async () => {
  // 只发响应头、body 永不产出 —— 这正是「下载卡在 downloading 状态」的成因
  const stalling = new Response(new ReadableStream({ start() { /* 永不 enqueue */ } }))
  const t0 = Date.now()
  await assert.rejects(
    () => readBodyWithStallWatchdog(stalling, { stallMs: 120 }),
    /下载停滞/,
  )
  assert.ok(Date.now() - t0 < 3_000, '必须在停滞阈值附近就判死，而不是一直等')
})

test('readBodyWithStallWatchdog：能响应调用方 signal 中止', async () => {
  const stalling = new Response(new ReadableStream({ start() { /* 永不 enqueue */ } }))
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('caller abort')), 60)
  await assert.rejects(() => readBodyWithStallWatchdog(stalling, { stallMs: 30_000, callerSignal: controller.signal }))
})

// ─────────────────────────────────────────────── 下载：校验与原子落盘

/** 造一个按 URL 分派的假 fetch。 */
function fakeFetch(routes) {
  return async (url, init) => {
    for (const [needle, handler] of routes) {
      if (String(url).includes(needle)) return handler(url, init)
    }
    return new Response('nope', { status: 404, statusText: 'Not Found' })
  }
}

function releaseJson(target, { withChecksumAsset = true } = {}) {
  const assets = [{ name: target, id: 11, url: 'https://api.github.com/assets/11' }]
  if (withChecksumAsset) assets.push({ name: `${target}.sha256`, id: 12, url: 'https://api.github.com/assets/12' })
  return { tag_name: 'v9.9.9', assets }
}

test('downloadBinary：拿不到 sha256 时拒绝安装（fail closed）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-dl-'))
  const cachePath = join(dir, 'bin', 'trade')
  const target = platformTarget()
  if (!target) return // 当前平台无产物，跳过

  const fetchImpl = fakeFetch([
    ['/releases/assets/11', async () => new Response(Buffer.alloc(4096, 7), { status: 200 })],
    ['api.github.com/repos', async () => new Response(JSON.stringify(releaseJson(target)), { status: 200, headers: { 'content-type': 'application/json' } })],
    // 校验和两条路都 404
  ])

  await assert.rejects(
    () => downloadBinary({ fetchImpl, cachePath, stallMs: 5_000 }),
    /拒绝安装未经完整性校验/,
  )
  assert.equal(existsSync(cachePath), false, '校验缺失时必须什么都没落盘')
})

test('downloadBinary：sha256 不匹配时拒绝，且不留半截文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-dl2-'))
  const cachePath = join(dir, 'bin', 'trade')
  const target = platformTarget()
  if (!target) return

  const wrongHash = 'f'.repeat(64)
  const fetchImpl = fakeFetch([
    ['/releases/assets/11', async () => new Response(Buffer.alloc(4096, 7), { status: 200 })],
    ['api.github.com/repos', async () => new Response(JSON.stringify(releaseJson(target)), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['.sha256', async () => new Response(`${wrongHash}  ${target}\n`, { status: 200 })],
  ])

  await assert.rejects(() => downloadBinary({ fetchImpl, cachePath, stallMs: 5_000 }), /sha256 不匹配/)
  assert.equal(existsSync(cachePath), false, '校验失败不得留下任何文件')
  // 也不该留下临时文件
  const binDir = join(dir, 'bin')
  const leftovers = (existsSync(binDir) ? readdirSync(binDir) : []).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [], '临时文件必须被清理')
})

test('downloadBinary：校验通过时原子落盘并置可执行位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-dl3-'))
  const cachePath = join(dir, 'bin', 'trade')
  const target = platformTarget()
  if (!target) return

  const payload = Buffer.alloc(4096, 9)
  const goodHash = createHash('sha256').update(payload).digest('hex')
  const fetchImpl = fakeFetch([
    ['/releases/assets/11', async () => new Response(payload, { status: 200 })],
    ['api.github.com/repos', async () => new Response(JSON.stringify(releaseJson(target)), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['.sha256', async () => new Response(`${goodHash}  ${target}\n`, { status: 200 })],
  ])

  const out = await downloadBinary({ fetchImpl, cachePath, stallMs: 5_000 })
  assert.equal(out.path, cachePath)
  assert.equal(out.version, 'v9.9.9', '走 API 分支时必须回传 Release 元数据里的 tag')
  assert.equal(existsSync(cachePath), true)
  assert.equal(isExecutableFile(cachePath), true, '必须置上可执行位')
  assert.equal(readFileSync(cachePath).length, 4096)
  const binDir = join(dir, 'bin')
  const leftovers = (existsSync(binDir) ? readdirSync(binDir) : []).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [], 'rename 之后不该残留临时文件')
})

// ─────────────────────────────────────────────── 账本安全：不删 WAL

test('createCliRunner：BUSY_RECOVERY 只退避重试，绝不删除账本 -wal/-shm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-busy-'))
  const dbPath = join(dir, 'ledger.db')
  writeFileSync(dbPath, 'db')
  const walPath = `${dbPath}-wal`
  const shmPath = `${dbPath}-shm`
  const walContent = 'committed-but-not-checkpointed'
  writeFileSync(walPath, walContent)
  writeFileSync(shmPath, 'shm')

  const counter = join(dir, 'called')
  const bin = fakeBinary(
    `if [ -f "${counter}" ]; then\n` +
      `  echo '{"code":0,"msg":"success","data":{"attempt":2}}'\n` +
      `else\n` +
      `  touch "${counter}"\n` +
      `  echo "SQLiteError: database is locked SQLITE_BUSY_RECOVERY" 1>&2\n` +
      `  exit 1\n` +
      `fi`,
  )

  const run = createCliRunner({ binary: bin, dbPath })
  const result = await run(['position'])
  assert.equal(result.ok, true, '退避后应重试成功')
  assert.equal(result.data.attempt, 2)

  // 核心负向断言：账本附属文件必须原样还在。
  // 旧实现命中 BUSY_RECOVERY 就 unlink -wal/-shm —— 只读调用也会删，
  // 而 -wal 可能含已提交未 checkpoint 的事务，删掉就是丢数据。
  assert.equal(existsSync(walPath), true, '-wal 不得被删除')
  assert.equal(existsSync(shmPath), true, '-shm 不得被删除')
  assert.equal(readFileSync(walPath, 'utf8'), walContent, '-wal 内容必须原封不动')
})

test('createCliRunner：持续 BUSY_RECOVERY 时如实上报，并说明该人工处理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-busy2-'))
  const dbPath = join(dir, 'ledger.db')
  writeFileSync(dbPath, 'db')
  const walPath = `${dbPath}-wal`
  writeFileSync(walPath, 'wal')

  const bin = fakeBinary(
    `echo "SQLiteError: database is locked SQLITE_BUSY_RECOVERY" 1>&2\n exit 1`,
  )
  const run = createCliRunner({ binary: bin, dbPath })
  const result = await run(['position'])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CLI_BUSY_RECOVERY_PERSISTENT')
  assert.match(result.message, /手动/)
  assert.equal(existsSync(walPath), true, '失败路径同样不得删除 -wal')
})

test('createCliRunner：同一账本上的调用被串行化（不自己制造锁竞争）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-serial-'))
  const dbPath = join(dir, 'ledger.db')
  const markDir = join(dir, 'marks')
  mkdirSync(markDir)

  // 假 CLI：进入时落一个标记、退出时删掉，再数标记数。
  // 串行时前后两次各自只看到自己那 1 个；并发时会同时看到 2 个。
  const bin = fakeBinary(
    `mark="${markDir}/$$"\n` +
      `touch "$mark"\n` +
      `sleep 0.15\n` +
      `n=$(ls "${markDir}" | wc -l | tr -d ' ')\n` +
      `rm -f "$mark"\n` +
      `echo "{\\"code\\":0,\\"msg\\":\\"success\\",\\"data\\":{\\"concurrent\\":$n}}"`,
  )
  const run = createCliRunner({ binary: bin, dbPath })
  const [a, b] = await Promise.all([run(['position']), run(['stats'])])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  // 若并发执行，第二个进程会看到 2 个标记
  assert.equal(a.data.concurrent, 1, '两次调用必须串行，不能同时持有账本')
  assert.equal(b.data.concurrent, 1)
})

// ─────────────────────────────────────────────── issue #6：未知收益率两层都要诚实

test('deriveBoard：null / 空串等真实形状的缺失收益率都不得变成 0', () => {
  // issue #6 指出的第一层：`Number(lot.return_rate)` 让 null 与 '' 都变成 0，
  // 于是「现价取不到」被归进「成本线附近」。同文件的 market_value / floating_pnl
  // 早已改用 finiteOrNull()，只有 rate 这行漏了 —— 这条把四种真实形状都钉住。
  const mk = (rate) =>
    deriveBoard(
      {
        portfolio_summary: {},
        targets: [
          { symbol: 'S', name: '测试标的', lots: [{ lot_id: 'A', return_rate: rate, floating_pnl: 5, current_price: 6, remaining_quantity: 100 }] },
        ],
      },
      null,
    )

  for (const missing of [null, '', undefined, NaN, 'n/a', '不是数字']) {
    const board = mk(missing)
    const lot = board.lotsByReturn[0]
    assert.equal(lot.return_rate, null, `return_rate=${JSON.stringify(missing)} 必须保持 null`)
    assert.equal(lot.rate_known, false)
    assert.equal(lot.bucket, UNKNOWN_BUCKET_ID, `return_rate=${JSON.stringify(missing)} 必须落到「收益率不可用」桶`)
    assert.equal(board.rate_unknown_count, 1)
    assert.equal(board.bucketCounts.find((b) => b.id === 'flat').count, 0, '不得混进成本线附近')
  }

  // 真实的 0 仍然要如实显示为 0（负向防误杀：别把真 0 也当成未知）
  for (const real of [0, 0.05, -0.25]) {
    const board = mk(real)
    const lot = board.lotsByReturn[0]
    assert.equal(lot.return_rate, real)
    assert.equal(lot.rate_known, true)
    assert.notEqual(lot.bucket, UNKNOWN_BUCKET_ID)
    assert.equal(board.rate_unknown_count, 0)
  }
  assert.equal(mk(0).lotsByReturn[0].bucket, 'flat', '真 0 才归成本线附近')
  assert.equal(mk(-0.25).lotsByReturn[0].bucket, 'deep-value')
})

test('client 的数值格式化：未知值渲染成 —，真 0 仍渲染成 0', () => {
  // issue #6 第二层：deriveBoard 把未知保持成 null 之后，只要渲染层再压回 0
  // 就前功尽弃。这里直接把 client.js 的纯函数出口拉进 node 验证，
  // 而不是靠读源码正则「守」。
  const helpers = loadClientHelpers()
  const { rateOf, pct, money, signedMoney, pnlColor, isUnknown } = helpers.__test

  assert.equal(typeof rateOf, 'function', '__test 端口必须存在')

  // 「没有值」与「值不合法」是两件事：isUnknown 只管前者，
  // NaN / 非数字字符串由后续的 Number.isFinite 兜住。两条路都必须落到 —。
  for (const noValue of [null, undefined, '']) {
    assert.equal(isUnknown(noValue), true, `isUnknown(${JSON.stringify(noValue)}) 应为 true`)
  }
  assert.equal(isUnknown(NaN), false, 'NaN 是「值不合法」，不是「没给值」——由 isFinite 兜')

  for (const missing of [null, undefined, '', NaN, 'n/a']) {
    assert.equal(rateOf(missing), null, `rateOf(${JSON.stringify(missing)}) 必须是 null`)
    // 这是 bug 的端到端形态：以前会渲染成 "0.00%"
    assert.equal(pct(rateOf(missing)), '—', `未知收益率必须显示 —，实际 ${pct(rateOf(missing))}`)
    assert.equal(money(missing), '—')
    assert.equal(signedMoney(missing), '—')
  }

  // 负向防误杀：真 0 不能被当成「未知」
  assert.equal(rateOf(0), 0)
  assert.equal(pct(rateOf(0)), '0.00%', '真实 0 必须显示 0.00%，不能也显示 —')
  assert.equal(money(0), '0.00')
  assert.equal(pct(rateOf(0.05)), '5.00%')
  assert.equal(pnlColor(0), pnlColor(null), '0 与未知都用中性色')
})

test('client 渲染路径不得再用 num() 吞掉收益率的 null（负向源码守卫）', () => {
  // 上面那条测的是 rateOf 本身；这条防的是「调用点又改回 num()」。
  // 源码守卫只能证明写法没退回，但配合上一条（rateOf 行为已单测）
  // 就覆盖了 issue #6 第二层的完整链路。
  const src = readFileSync(join(pluginDir, 'client.js'), 'utf8')
  assert.doesNotMatch(
    src,
    /num\([^)]*return_rate/,
    '收益率展示不得经过 num()：Number(null) 是 0，会把未知渲染成 0.00%',
  )
  assert.match(src, /rateOf\(/, '必须走 rateOf 这一层')
  // 三个已知调用点都要在
  // 注意：定义处写的是 `const rateOf = (v) =>`，所以 `rateOf(` 只匹配调用点
  const sites = src.match(/rateOf\(/g) ?? []
  assert.ok(sites.length >= 3, `rateOf 应出现在全部 3 个展示调用点，实际 ${sites.length}`)
})

// ─────────────────────────────────────────────── 下载：竞速赢家

test('downloadBinary：两条路径竞速时用先到的那条，并中止落败的一条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-race-'))
  const cachePath = join(dir, 'bin', 'trade')
  const target = platformTarget()
  if (!target) return

  const payloadDirect = Buffer.alloc(4096, 1)
  const payloadApi = Buffer.alloc(4096, 2)
  const directHash = createHash('sha256').update(payloadDirect).digest('hex')
  /** API 分支是否在直链胜出后**仍然去下载了二进制** —— 这是要防的浪费。 */
  let apiAssetFetched = false

  const fetchImpl = async (url) => {
    const u = String(url)
    // 直链：立刻返回合法二进制 → 应当赢下竞速
    if (u.startsWith('https://github.com/')) {
      if (u.endsWith('.sha256')) return new Response(`${directHash}  ${target}\n`, { status: 200 })
      return new Response(payloadDirect, { status: 200 })
    }
    // API 元数据：故意慢一拍，让直链先赢
    if (u.includes('/releases/latest')) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return new Response(JSON.stringify(releaseJson(target)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // 走到这里说明 API 分支在败局已定后还想拉资产 —— 正是要拦的
    if (u.includes('/releases/assets/')) {
      apiAssetFetched = true
      return new Response(payloadApi, { status: 200 })
    }
    return new Response('nope', { status: 404 })
  }

  const out = await downloadBinary({ fetchImpl, cachePath, stallMs: 5_000 })
  assert.equal(out.path, cachePath)
  // 校验和只匹配直链那份；能成功就说明采用的确实是直链拿到的内容
  assert.equal(readFileSync(cachePath).equals(payloadDirect), true, '必须采用先到的那份内容')

  // 负向：直链常赶在元数据返回前就赢，那时输家的下载槽还没建出来，
  // 光写 slot?.abort() 是空操作。必须保证输家不会再去拉一遍 89MB。
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(apiAssetFetched, false, '直链胜出后，API 分支不得再去下载一遍二进制（纯浪费带宽）')
})

// ─────────────────────────────────────────────── 引擎版本锁

test('normalizeConfig：binaryVersion 默认跟随 latest，可钉死具体 tag', () => {
  assert.equal(normalizeConfig({}).binaryVersion, '', '默认空串 = 跟随 latest')
  assert.equal(normalizeConfig({ binaryVersion: 'v0.1.0' }).binaryVersion, 'v0.1.0')
  assert.equal(normalizeConfig({ binaryVersion: '  v0.1.0  ' }).binaryVersion, 'v0.1.0', '两端空白要剪掉')
  assert.equal(normalizeConfig({ binaryVersion: 123 }).binaryVersion, '', '非字符串按未设置处理')
  assert.equal(normalizeConfig({ binaryVersion: null }).binaryVersion, '')
})

test('downloadBinary：钉住版本时请求的是那个 tag，而不是 latest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-pin-'))
  const cachePath = join(dir, 'bin', 'trade')
  const target = platformTarget()
  if (!target) return

  const payload = Buffer.alloc(4096, 3)
  const hash = createHash('sha256').update(payload).digest('hex')
  const requested = []

  const fetchImpl = async (url) => {
    const u = String(url)
    requested.push(u)
    if (u.includes('/releases/tags/v0.1.0')) {
      return new Response(JSON.stringify(releaseJson(target)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/releases/assets/11')) return new Response(payload, { status: 200 })
    if (u.endsWith('.sha256')) return new Response(`${hash}  ${target}\n`, { status: 200 })
    return new Response('nope', { status: 404 })
  }

  const out = await downloadBinary({ fetchImpl, cachePath, version: 'v0.1.0', stallMs: 5_000 })
  assert.equal(out.version, 'v9.9.9', 'version 回传的是 Release 元数据里的真实 tag')
  assert.equal(existsSync(cachePath), true)
  // 负向：钉住后就不该再去问 latest
  assert.ok(
    requested.some((u) => u.includes('/releases/tags/v0.1.0')),
    '钉住版本时必须走 tags/<version> 端点',
  )
  assert.ok(
    !requested.some((u) => u.includes('/releases/latest')),
    '钉住版本后不得再请求 latest（否则锁等于没锁）',
  )
})

// ─────────────────────────────────────────────── #7：engine_version 不能是占位符

/** 造一个能带 `url` 的假 Response（真 Response 的 url 是只读 getter，改不了）。 */
function fakeFetchResponse(body, { url = '', status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(body))
        controller.close()
      },
    }),
    async arrayBuffer() {
      return body.buffer ?? body
    },
    async text() {
      return Buffer.from(body).toString('utf8')
    },
  }
}

/** 装配一个「只有直链可用」的环境，返回 { fetchImpl, calls }。 */
function directOnlyFetch(target, payload, hash, finalUrl) {
  const directUrl = `https://github.com/Goodfun-Studio/lot-trader/releases/latest/download/${target}`
  const calls = []
  const fetchImpl = async (url, init) => {
    const u = String(url)
    calls.push(u)
    if (u.endsWith('.sha256')) return fakeFetchResponse(Buffer.from(`${hash}  ${target}\n`))
    if (u === directUrl) return fakeFetchResponse(payload, { url: finalUrl(u) })
    // API 分支永远挂住 → 直链必然胜出
    return new Promise((_, reject) => {
      init?.signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
    })
  }
  return { fetchImpl, calls, directUrl }
}

test('#7 直链胜出时从最终响应地址解析 tag，而不是退回占位符 "latest"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-tag-'))
  const cachePath = join(dir, 'bin', 'trade')
  const target = platformTarget()
  if (!target) return

  const payload = Buffer.alloc(4096, 5)
  const hash = createHash('sha256').update(payload).digest('hex')
  // GitHub 会把 …/releases/latest/download/<asset> 重定向成带 tag 的地址
  const { fetchImpl } = directOnlyFetch(target, payload, hash, (u) => u.replace('/latest/download/', '/download/v9.9.9/'))

  const out = await downloadBinary({ fetchImpl, cachePath, stallMs: 5_000 })
  assert.equal(out.version, 'v9.9.9', '直链胜出时必须从 response.url 解析出真实 tag')
  assert.notEqual(out.version, 'latest', '绝不退回占位符')
})

test('#7 直链胜出但解析不到 tag 时返回 null，不编占位符', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-tag2-'))
  const cachePath = join(dir, 'bin', 'trade')
  const target = platformTarget()
  if (!target) return

  const payload = Buffer.alloc(4096, 6)
  const hash = createHash('sha256').update(payload).digest('hex')
  // 真实世界里 redirect 的终点可能是 CDN 签名地址，路径里没有 /releases/download/<tag>/
  const { fetchImpl } = directOnlyFetch(target, payload, hash, () => 'https://release-assets.githubusercontent.com/signed/opaque-token')

  const out = await downloadBinary({ fetchImpl, cachePath, stallMs: 5_000 })
  assert.equal(out.version, null, '解析不到就如实返回 null（与「手动放置的二进制保持 null」一致）')
  assert.notEqual(out.version, 'latest', '拿不到就说不知道，不能伪造一个像版本号的字符串')
})

test('#7 钉住版本时直链请求 URL 本身就带 tag，无需依赖 response.url', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-tag3-'))
  const cachePath = join(dir, 'bin', 'trade')
  const target = platformTarget()
  if (!target) return

  const payload = Buffer.alloc(4096, 8)
  const hash = createHash('sha256').update(payload).digest('hex')
  const pinned = 'v0.1.0'
  const pinnedUrl = `https://github.com/Goodfun-Studio/lot-trader/releases/download/${pinned}/${target}`
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.endsWith('.sha256')) return fakeFetchResponse(Buffer.from(`${hash}  ${target}\n`))
    if (u === pinnedUrl) return fakeFetchResponse(payload, { url: 'https://objects.githubusercontent.com/opaque' })
    return new Promise((_, reject) => {
      init?.signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
    })
  }

  const out = await downloadBinary({ fetchImpl, cachePath, version: pinned, stallMs: 5_000 })
  assert.equal(out.version, pinned, '即使 response.url 里没有 tag，钉住的版本也应能从请求 URL 得到')
})

// ─────────────────────────────────────────────── disciplineOrder：负号与告警

test('toFiniteNumber 接受负数与数字字符串（toPositiveNumber 不适用于顺序类配置）', () => {
  assert.equal(toFiniteNumber(-100), -100)
  assert.equal(toFiniteNumber('-100'), -100, '字符串形态也要保住符号')
  assert.equal(toFiniteNumber(' -100 '), -100)
  assert.equal(toFiniteNumber(0), 0, '0 是合法顺序值（部署人格）')
  assert.equal(toFiniteNumber('0'), 0)
  assert.equal(toFiniteNumber(170), 170)
  assert.equal(toFiniteNumber('abc'), undefined)
  assert.equal(toFiniteNumber(''), undefined)
  assert.equal(toFiniteNumber(null), undefined)
  assert.equal(toFiniteNumber(NaN), undefined)
  assert.equal(toFiniteNumber(Infinity), undefined)
  // 对比：正数版会吃掉负号 —— 这正是不能复用它解析 disciplineOrder 的原因
  assert.equal(toPositiveNumber('-100'), undefined, 'toPositiveNumber 本就不接受负数')
})

test('normalizeConfig：disciplineOrder 保住负号，非法值真的要告警（不再是死代码）', () => {
  // 修复前：这条告警的条件恒为假（disciplineOrder 必是有限数），
  // 于是 "abc" 静默回退 170、"−100" 连值带符号一起丢，都没有任何提示。
  assert.equal(normalizeConfig({ disciplineOrder: -100 }).disciplineOrder, -100)
  assert.equal(normalizeConfig({ disciplineOrder: '-100' }).disciplineOrder, -100, '字符串负号不能丢')
  assert.deepEqual(normalizeConfig({ disciplineOrder: '-100' }).warnings, [])
  assert.equal(normalizeConfig({ disciplineOrder: '0' }).disciplineOrder, 0)
  assert.equal(normalizeConfig({ disciplineOrder: 200 }).disciplineOrder, 200)
  assert.equal(normalizeConfig({ disciplineOrder: '170' }).disciplineOrder, 170)

  // 负向：非法值必须留痕
  const bad = normalizeConfig({ disciplineOrder: 'abc' })
  assert.equal(bad.disciplineOrder, 170, '回退到默认')
  assert.equal(bad.warnings.length, 1, '必须告警 —— 修复前这里是静默的')
  assert.match(bad.warnings[0], /disciplineOrder/)

  // 没配 / 空串不算「配错了」，不该刷告警
  assert.deepEqual(normalizeConfig({}).warnings, [])
  assert.deepEqual(normalizeConfig({ disciplineOrder: '' }).warnings, [])
  assert.deepEqual(normalizeConfig({ disciplineOrder: null }).warnings, [])
})

// ────────────────────────────────── 引擎静默回落：插件能标与不能标的边界

test('deriveBoard：引擎「不认识」的标的不得把回落价算出的收益率当成正常值', () => {
  // 实测（临时账本 + 真引擎）：买入一个不存在的代码 999999 后，
  //   引擎 current_price 回落到 buy_price=10，return_rate = -0.0009（纯粹是规费），
  //   且输出里**没有任何回落标记**（src/position.ts 只做 `q.current_price > 0 ? … : fallbackPrice`）。
  // 于是「收益率不可用」桶在真实场景里永远空着，用户看到的是编出来的数字。
  //
  // 插件唯一能确定的是「引擎不认识这个标的」：symbols 表里查不到人类可读名时，
  // name 会退化成代码本身。这条覆盖它；**不覆盖**「已知标的行情临时失败」。
  const mk = (name, symbol, rate) =>
    deriveBoard(
      {
        portfolio_summary: {},
        targets: [{ symbol, name, lots: [{ lot_id: 'A', return_rate: rate, floating_pnl: -0.9, current_price: 10, remaining_quantity: 100 }] }],
      },
      null,
    )

  const bad = mk('999999', '999999.SH', -0.0009)
  const badLot = bad.lotsByReturn[0]
  assert.equal(badLot.return_rate, null, '引擎不认识的标的，收益率必须标为未知')
  assert.equal(badLot.rate_known, false)
  assert.equal(badLot.bucket, UNKNOWN_BUCKET_ID, '必须落进「收益率不可用」桶，而不是浅度回撤梯队')
  assert.equal(badLot.rate_source, 'unresolved_symbol')
  assert.equal(bad.rate_unknown_count, 1)
  assert.deepEqual(bad.unresolved_symbols, ['999999.SH'])
  assert.equal(bad.bucketCounts.find((b) => b.id === 'pullback').count, 0, '不得混进浅度回撤梯队')

  // 负向防误杀：正常标的必须照常显示真实收益率
  const good = mk('黄金ETF华安', '518880.SH', 0.0307)
  const goodLot = good.lotsByReturn[0]
  assert.equal(goodLot.return_rate, 0.0307)
  assert.equal(goodLot.bucket, 'flat')
  assert.equal(goodLot.rate_source, 'engine')
  assert.deepEqual(good.unresolved_symbols, [])

  // name 缺失也算「不认识」
  assert.equal(mk(undefined, 'X.SH', 0.01).lotsByReturn[0].rate_source, 'unresolved_symbol')
  // 但 name 只是恰好等于**裸代码**才算；带后缀的 symbol 与 name 不同 => 已解析
  assert.equal(mk('518880.SH', '518880.SH', 0.01).lotsByReturn[0].rate_source, 'engine')
})

test('纪律切片：不得再声称「看板会标 degraded」（那是假承诺）', () => {
  // 原句是「现价取不到时引擎会回落到买入价，看板会标 degraded」。
  // 实测：回落到买入价确实发生，但 degraded 只在**整条 position 调用失败**时置位，
  // 行情回落根本不会触发它（引擎不暴露该事实）。留着这句会让模型对着一个
  // 编出来的收益率告诉用户「已标降级」——比不说更危险。
  const text = renderDiscipline({})
  assert.doesNotMatch(text, /看板会标 degraded/, '这句是假承诺，必须删掉')
  assert.match(text, /静默回落/, '要说清引擎是静默回落的')
  assert.match(text, /trade_physics/, '要给出可复核的手段')
  assert.match(text, /无法为已知标的检测|无法检测/, '要如实说明插件的检测边界')
})

test('describeCapWarning：默认 cap 导致仓位条全部顶格时必须提示', () => {
  const board = (rates) => ({ symbols: rates.map((rate, i) => ({ symbol: `S${i}.SH`, current_position_rate: rate })) })

  // cap=0（未配置）+ 有标的顶格 → 必须提示
  const warn = describeCapWarning(board([1.24, 5.02, 0.3]), 0)
  assert.ok(warn, '必须给出提示')
  assert.match(warn, /2\/3/, '要给出顶格比例')
  assert.match(warn, /50000/, '要点明引擎默认额度')
  assert.match(warn, /cap/, '要指出去哪改')

  // 负向防误杀：三种不该提示的情形
  assert.equal(describeCapWarning(board([0.3, 0.5]), 0), null, '没人顶格不提示')
  assert.equal(describeCapWarning(board([]), 0), null, '空组合不提示')
  assert.equal(describeCapWarning(board([1.5, 2.0]), 300_000), null, '用户已显式设 cap 就不该再唠叨')
  assert.equal(describeCapWarning(undefined, 0), null, '没有 board 不炸')
})

test('downloadBinary：API 校验和候选必须带 accept: application/octet-stream', async () => {
  // 不带这个头时 GitHub 的 asset API 返回的是 **JSON 元数据**，64 位十六进制正则
  // 匹配不上 → 候选被静默丢弃 → 最终「拿不到 sha256，拒绝安装」，
  // 而此时 85MB 已经白下完了。二进制那条路本来就有这个头，校验和这条路漏了。
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-accept-'))
  const cachePath = join(dir, 'bin', 'trade')
  const target = platformTarget()
  if (!target) return

  const payload = Buffer.alloc(4096, 4)
  const hash = createHash('sha256').update(payload).digest('hex')
  const seen = []

  const fetchImpl = async (url, init) => {
    const u = String(url)
    const accept = init?.headers?.accept ?? init?.headers?.Accept ?? null
    seen.push({ url: u, accept })
    // 直链整条路都不通（模拟 github.com 被墙）
    if (u.startsWith('https://github.com/')) return new Response('nope', { status: 404 })
    if (u.includes('/releases/assets/11')) return new Response(payload, { status: 200 })
    if (u.includes('/releases/assets/12')) {
      // 忠实模拟 GitHub：不带 accept 就返回 JSON 元数据而不是文件内容
      if (accept !== 'application/octet-stream') {
        return new Response(JSON.stringify({ name: `${target}.sha256`, size: 80 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(`${hash}  ${target}\n`, { status: 200 })
    }
    if (u.includes('api.github.com/repos')) {
      return new Response(JSON.stringify(releaseJson(target)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('nope', { status: 404 })
  }

  const out = await downloadBinary({ fetchImpl, cachePath, stallMs: 5_000 })
  assert.equal(out.path, cachePath, '能装上说明校验和这条路通了')

  const checksumCall = seen.find((c) => c.url.includes('/releases/assets/12'))
  assert.ok(checksumCall, '应当尝试过 API 校验和 asset')
  assert.equal(checksumCall.accept, 'application/octet-stream', '不带这个头拿回的是 JSON 元数据，校验必然失败')
})
