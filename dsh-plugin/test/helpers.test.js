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
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RETURN_BUCKETS,
  TOOL_NAMES,
  TradeCliError,
  WRITE_TOOLS,
  bunBuildTarget,
  createCliRunner,
  createTradeTools,
  deriveBoard,
  downloadBinary,
  expandHome,
  normalizeConfig,
  parseJsonLoose,
  platformTarget,
  resolveBinary,
  resolveDbPath,
  runOrThrow,
  stripLots,
} from '../tools.js'

import { describeWrite, isLoopbackRequest, renderDiscipline } from '../index.js'

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

test('trade_lot_list 在插件侧排序与分页，且 --status ALL 不传 flag', async () => {
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

  const byTime = await list.execute({})
  assert.deepEqual(byTime.rows.map((row) => row.lot_id), ['B', 'C', 'A'], '默认按买入时间倒序')
  assert.equal(seen[0].includes('--status'), true)
  assert.equal(seen[0][seen[0].indexOf('--status') + 1], 'ACTIVE')

  const byReturn = await list.execute({ sort_by: 'return_rate', limit: 2 })
  assert.deepEqual(byReturn.rows.map((row) => row.lot_id), ['C', 'A'])
  assert.equal(byReturn.total, 3)
  assert.equal(byReturn.returned, 2)

  const paged = await list.execute({ sort_by: 'return_rate', limit: 1, offset: 2 })
  assert.deepEqual(paged.rows.map((row) => row.lot_id), ['B'])

  const all = await list.execute({ status: 'ALL' })
  assert.equal(all.total, 3)
  assert.equal(seen.at(-1).includes('--status'), false, 'ALL 不该把 --status ALL 传给引擎')
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

  // 分层透视覆盖全部批次，且与 RETURN_BUCKETS 同构
  assert.equal(board.bucketCounts.length, RETURN_BUCKETS.length)
  assert.equal(board.bucketCounts.reduce((sum, bucket) => sum + bucket.count, 0), 4)
  const bucketOf = (id) => board.bucketCounts.find((bucket) => bucket.id === id).count
  assert.equal(bucketOf('deep-value'), 1, 'B 的 -25% 必须落进深度击球区')
  assert.equal(bucketOf('flat'), 1, 'A 的 +5% 必须落进成本线附近')
  assert.equal(bucketOf('take-profit'), 1, 'D 的 +15% 必须落进止盈梯队')
  assert.equal(bucketOf('peak'), 1, 'C 的 +31% 必须落进高位浮盈梯队')
  assert.equal(bucketOf('dip'), 0)
  assert.equal(bucketOf('pullback'), 0)
  assert.equal(board.stats.total_trades, 7)
})

test('deriveBoard：空账本与脏数据不产生 NaN', () => {
  const empty = deriveBoard(undefined, undefined)
  assert.equal(empty.lots_count, 0)
  assert.deepEqual(empty.lotsByTime, [])
  assert.equal(empty.portfolio, null)

  const dirty = deriveBoard(
    { targets: [{ symbol: 'X', lots: [{ lot_id: 'A', return_rate: 'not-a-number', current_price: null, remaining_quantity: undefined }] }] },
    null,
  )
  const lot = dirty.lotsByTime[0]
  assert.equal(Number.isFinite(lot.return_rate), true)
  assert.equal(Number.isFinite(lot.floating_pnl), true)
  assert.equal(Number.isFinite(lot.market_value), true)
  assert.equal(lot.bucket, 'flat')
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
  assert.equal(describeWrite('something_else', {}), 'something_else')
})

test('isLoopbackRequest 只放回环，拒绝同网段', () => {
  const req = (remoteAddress, host) => ({ socket: { remoteAddress }, headers: host ? { host } : {} })

  assert.equal(isLoopbackRequest(req('127.0.0.1', '127.0.0.1:8080')), true)
  assert.equal(isLoopbackRequest(req('::1', 'localhost:8080')), true)
  assert.equal(isLoopbackRequest(req('::ffff:127.0.0.1', '[::1]:8080')), true)
  assert.equal(isLoopbackRequest(req(undefined, '127.0.0.1:8080')), true)

  // 负向防误杀：非回环一律拒
  assert.equal(isLoopbackRequest(req('192.168.1.9', '192.168.1.9:8080')), false)
  assert.equal(isLoopbackRequest(req('10.0.0.3', undefined)), false)
  assert.equal(isLoopbackRequest(req('127.0.0.1', 'evil.example.com')), false)
})

// ─────────────────────────────────────────────── 自动下载与平台映射

test('platformTarget 按 os×arch 映射到 release asset 名', () => {
  const t = platformTarget()
  // 断言形状而不是硬编码本机值，这样在任何 CI 机器上都成立
  if (process.platform === 'darwin') {
    assert.match(t, /^trade-darwin-(x64|arm64)$/)
    assert.equal(t, process.arch === 'arm64' ? 'trade-darwin-arm64' : 'trade-darwin-x64')
  } else if (process.platform === 'linux') {
    assert.match(t, /^trade-linux-(x64|arm64)$/)
    assert.equal(t, process.arch === 'arm64' ? 'trade-linux-arm64' : 'trade-linux-x64')
  } else if (process.platform === 'win32') {
    assert.match(t, /^trade-windows-(x64|arm64)\.exe$/)
  } else {
    assert.equal(t, null, '未预编译的平台必须返回 null，而不是编一个不存在的名字')
  }
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
