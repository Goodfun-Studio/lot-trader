/**
 * 端到端测试：用**真实 trade 引擎**驱动插件工具层。
 *
 * 为什么需要它：契约测试只断言 argv 形状（「有没有传 --status」），
 * 而 issue #1 的教训正相反 —— argv 看起来「按设计」不带 flag，引擎却回了一份
 * ACTIVE-only 的数据。**只锁 argv 的测试发现不了「引擎实际返回了什么」的错**。
 * 所以这里起一个真账本、跑真引擎、断言最终结果集。
 *
 * 没有可用二进制时**跳过**而不是失败：CI 的发布流水线在构建二进制之前就跑测试，
 * 此文件在那种环境下不适用。
 *
 * 独立运行：
 *   node --test test/e2e.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCliRunner, createTradeTools, resolveBinary, TOOL_NAMES } from '../tools.js'

const binary = resolveBinary('')
const hasBinary = binary.source !== 'PATH' && existsSync(binary.path)

/**
 * `LOT_TRADER_REQUIRE_E2E=1` 时，没有二进制就**直接失败**而不是跳过。
 *
 * 必须有这个开关：CI 里那条「用刚构建的二进制跑 e2e」的门禁，
 * 如果因为探测不到二进制而静默 skip，整步照样绿灯 —— 门禁就成了摆设。
 * 默认不设，这样开发机（或构建产物之前）跑全量测试时它会安静跳过。
 */
if (!hasBinary && process.env.LOT_TRADER_REQUIRE_E2E === '1') {
  throw new Error(
    `LOT_TRADER_REQUIRE_E2E=1 但探测不到可用的 trade 二进制（来源：${binary.source}）。` +
      '这条端到端门禁会变成空跑，故直接失败。',
  )
}

const skip = hasBinary ? false : `本机没有可用的 trade 二进制（探测链落到 ${binary.source}），跳过端到端`

/** 造一个临时账本，返回 { dir, dbPath, run }。 */
function freshLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'lot-trader-e2e-'))
  const dbPath = join(dir, 'ledger.db')
  return { dir, dbPath, run: createCliRunner({ binary: binary.path, dbPath }) }
}

/** 直接调引擎（不走插件），作为「引擎口径」的对照基线。 */
async function engineJson(dbPath, args, { expectOk = true } = {}) {
  const run = createCliRunner({ binary: binary.path, dbPath })
  const result = await run(args)
  if (expectOk) assert.equal(result.ok, true, `引擎直调失败：${result.message}`)
  return result.ok ? result.data : result
}

/**
 * 播一个不触发 30% 硬顶的组合。
 *
 * 引擎在买入前核算「该标的买入后占组合的比例」，超过 30% 直接拒绝。
 * 所以等额买两个标的一定会被拦（各 50%）—— 这不是 bug，是风控在工作，
 * 播种数据必须尊重它：先建一个大锚仓把分母撑起来，再挂小卫星。
 */
async function seedPortfolio(dbPath, satellites = []) {
  await engineJson(dbPath, ['account', 'add', '--id', 'E2E', '--name', '端到端', '--broker', 'CUSTOM'])
  // 锚仓：组合为空时第一笔不受比例约束，正好用来把总值撑大
  await engineJson(dbPath, ['lot', 'buy', '--symbol', '518880', '--price', '6.00', '--qty', '10000', '--account', 'E2E'])
  for (const [symbol, price, qty] of satellites) {
    await engineJson(dbPath, ['lot', 'buy', '--symbol', symbol, '--price', String(price), '--qty', String(qty), '--account', 'E2E'])
  }
}

test('端到端：status=ALL 与引擎直调结果集一致（issue #1 的防回归）', { skip }, async () => {
  const { dbPath, run } = freshLedger()
  // 用**天然 T+0** 的黄金 ETF 做「当日买入当日平仓」，避开法定 T+1 的裸卖空拦截
  await seedPortfolio(dbPath, [['159934', 5.0, 100], ['510500', 5.5, 100]])

  // 把其中一个小卫星平掉，制造 ACTIVE + CLOSED 混合
  const listed = await engineJson(dbPath, ['lot', 'list'])
  const victim = listed.find((row) => String(row.symbol).startsWith('159934'))
  assert.ok(victim, '播种后应能找到 159934 的批次')
  await engineJson(dbPath, ['lot', 'close', '--lot-id', victim.lot_id, '--price', '5.05', '--qty', '100'])

  const tools = createTradeTools({ run, getCap: () => 0 })
  const tool = (name) => tools.find((t) => t.name === name)

  const all = await tool(TOOL_NAMES.lotList).execute({ status: 'ALL' })
  const engineAll = await engineJson(dbPath, ['lot', 'list', '--status', 'ALL'])
  assert.equal(all.total, engineAll.length, `插件 ALL 应拿到 ${engineAll.length} 笔，实际 ${all.total}`)

  const active = await tool(TOOL_NAMES.lotList).execute({})
  const closed = await tool(TOOL_NAMES.lotList).execute({ status: 'CLOSED' })

  assert.equal(closed.total, 1, 'CLOSED 只应有 1 笔')
  assert.ok(closed.rows.every((row) => row.status === 'CLOSED'), 'CLOSED 筛选下不该混进 ACTIVE')
  assert.equal(active.total + closed.total, all.total, 'ALL = ACTIVE + CLOSED')
  // 核心负向断言：ALL 与默认视图相同，就说明 ALL 被静默降级成了 ACTIVE
  assert.notEqual(all.total, active.total, 'ALL 必须与默认视图不同 —— 相同即 ALL 被静默降级')
})

test('端到端：只读工具不得改动账本附属文件', { skip }, async () => {
  const { dbPath, run } = freshLedger()
  await seedPortfolio(dbPath, [])

  // 只钉「文件是否还在」。不比较 mtime/size 是有原因的：
  //   1. SQLite 打开数据库本来就会创建/触碰 -wal/-shm；
  //   2. 引擎的 position 自身也会写库（刷新标的元数据等）。
  // 这些都是引擎的正常行为，插件管不着。旧实现的 bug 是**主动 unlink**
  // 这两个文件（可能丢掉已提交未 checkpoint 的事务），所以要钉的就是「没被删」。
  const artifacts = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
  const fingerprint = () => artifacts.map((p) => (existsSync(p) ? 'present' : 'absent'))
  const before = fingerprint()
  assert.ok(before.every((v) => v === 'present'), '播种后账本及其 -wal/-shm 应都已存在')

  const tools = createTradeTools({ run, getCap: () => 0 })
  const tool = (name) => tools.find((t) => t.name === name)
  await tool(TOOL_NAMES.lotList).execute({ status: 'ALL' })
  await tool(TOOL_NAMES.stats).execute({})
  await tool(TOOL_NAMES.position).execute({})

  // 旧实现在 BUSY_RECOVERY 时会 unlink -wal/-shm，且只读路径同样会走到那个分支。
  // 这条把「读操作零副作用」钉住。
  const after = fingerprint()
  assert.deepEqual(after, before, '只读工具不得删除账本或其 -wal/-shm')
})

test('端到端：写工具的 execute 真的落库，且能被后续读工具看见', { skip }, async () => {
  const { dbPath, run } = freshLedger()
  await seedPortfolio(dbPath, [])

  let mutations = 0
  const tools = createTradeTools({
    run,
    getCap: () => 0,
    onMutate: () => {
      mutations += 1
    },
  })
  const tool = (name) => tools.find((t) => t.name === name)

  // 天然 T+0，当日就能平掉
  const bought = await tool(TOOL_NAMES.lotBuy).execute({ symbol: '159934', price: 5.0, qty: 100, account: 'E2E' })
  assert.ok(bought.lot_id, '买入应返回 lot_id')
  assert.equal(mutations, 1, '写成功必须触发 onMutate（让快照失效）')

  const listed = await tool(TOOL_NAMES.lotList).execute({})
  assert.ok(listed.rows.some((row) => row.lot_id === bought.lot_id), '刚买的批次必须能被批次查询看见')

  await tool(TOOL_NAMES.lotClose).execute({ lot_id: bought.lot_id, price: 5.05 })
  assert.equal(mutations, 2)

  const afterActive = await tool(TOOL_NAMES.lotList).execute({})
  const afterAll = await tool(TOOL_NAMES.lotList).execute({ status: 'ALL' })
  assert.equal(afterActive.total, 1, '平掉卫星后只剩锚仓是 ACTIVE')
  assert.equal(afterAll.total, 2, 'ALL 应同时看见锚仓与被平掉的那笔')
})

test('端到端：引擎拒绝的操作必须原样抛错，不伪装成成功', { skip }, async () => {
  const { dbPath, run } = freshLedger()
  await seedPortfolio(dbPath, [])
  const tools = createTradeTools({ run, getCap: () => 0 })
  const tool = (name) => tools.find((t) => t.name === name)

  // 不存在的批次平仓
  await assert.rejects(
    () => tool(TOOL_NAMES.lotClose).execute({ lot_id: 'LOT-DOES-NOT-EXIST', price: 1 }),
    /失败/,
    '不存在的批次平仓必须抛错',
  )
  // 非整百股数 —— 引擎的前置校验必须原样穿到工具层
  await assert.rejects(
    () => tool(TOOL_NAMES.lotBuy).execute({ symbol: '588000', price: 1.0, qty: 150, account: 'E2E' }),
    /失败|整百/,
    '非整百股数必须被拒，不能静默取整',
  )
})

test('端到端：单标的 30% 硬顶会真的拦截（风控是真闸门）', { skip }, async () => {
  const { dbPath, run } = freshLedger()
  await engineJson(dbPath, ['account', 'add', '--id', 'E2E', '--name', '端到端', '--broker', 'CUSTOM'])
  // 一个很小的锚仓（600 元），让下一个标的有机会超过 30%
  await engineJson(dbPath, ['lot', 'buy', '--symbol', '518880', '--price', '6.00', '--qty', '100', '--account', 'E2E'])

  const tools = createTradeTools({ run, getCap: () => 0 })
  const tool = (name) => tools.find((t) => t.name === name)

  // 再买一个 380 元的新标的 → 买入后占 380/980 ≈ 38.8% > 30% → 必被拦
  await assert.rejects(
    () => tool(TOOL_NAMES.lotBuy).execute({ symbol: '510300', price: 3.8, qty: 100, account: 'E2E' }),
    /30|硬顶|风控/,
    '引擎的 30% 硬顶必须原样穿到工具层，不能被吞成「成功」',
  )
})

test('端到端：位置视图与批次视图对得上', { skip }, async () => {
  const { dbPath, run } = freshLedger()
  await seedPortfolio(dbPath, [['510300', 3.8, 100]])

  const tools = createTradeTools({ run, getCap: () => 0 })
  const full = await tools.find((t) => t.name === TOOL_NAMES.position).execute({ include_lots: true })
  const slim = await tools.find((t) => t.name === TOOL_NAMES.position).execute({})

  assert.equal(slim.targets.length, full.targets.length, '两种形态的标的数必须一致')
  assert.ok(
    slim.targets.every((t) => t.lots === undefined && typeof t.lots_count === 'number'),
    '默认形态只给 lots_count，不内联批次',
  )
  const inlined = full.targets.reduce((sum, t) => sum + (Array.isArray(t.lots) ? t.lots.length : 0), 0)
  assert.equal(inlined, 2, 'include_lots 时应内联全部 2 笔')
})
