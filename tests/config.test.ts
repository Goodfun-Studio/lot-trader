/**
 * `trade config` + src/config.ts
 *
 * Every test points LOT_TRADER_CONFIG_DIR at a fresh temp dir, so nothing here reads or
 * writes the developer's real ~/.lot-trader/config.json.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getConfigPath,
  getFullPositionCap,
  loadConfig,
  setConfigValue,
} from "../src/config.ts";
import { AppDatabase } from "../src/db.ts";
import { PositionAggregator } from "../src/position.ts";
import { QuoteProvider } from "../src/quotes.ts";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");

let configDir: string;
const savedEnv = {
  dir: process.env.LOT_TRADER_CONFIG_DIR,
  cap: process.env.LOT_TRADER_FULL_POSITION_CAP,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "lot-trader-config-"));
  process.env.LOT_TRADER_CONFIG_DIR = configDir;
  delete process.env.LOT_TRADER_FULL_POSITION_CAP;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  restoreEnv("LOT_TRADER_CONFIG_DIR", savedEnv.dir);
  restoreEnv("LOT_TRADER_FULL_POSITION_CAP", savedEnv.cap);
});

async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LOT_TRADER_CONFIG_DIR: configDir,
      LOT_TRADER_DB: join(configDir, "ledger.db"),
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("config 模块：读写与校验", () => {
  test("配置路径受 LOT_TRADER_CONFIG_DIR 控制", () => {
    expect(getConfigPath()).toBe(join(configDir, "config.json"));
  });

  test("没有配置文件时返回空对象，cap 走默认 50000", () => {
    expect(loadConfig()).toEqual({});
    expect(getFullPositionCap()).toBe(50000);
  });

  test("set 后能读回，并以原子方式落盘（不留 .tmp）", () => {
    setConfigValue("full_position_cap", 100000);
    expect(loadConfig()).toEqual({ full_position_cap: 100000 });
    expect(JSON.parse(readFileSync(getConfigPath(), "utf-8"))).toEqual({ full_position_cap: 100000 });
    expect(readdirSync(configDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test.each([
    ["0", 0],
    ["负数", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["超过 100 亿", 1e10 + 1],
  ])("拒绝非法值：%s", (_label, value) => {
    expect(() => setConfigValue("full_position_cap", value)).toThrow();
    expect(existsSync(getConfigPath())).toBe(false);
  });

  test("边界内的合法值不被误拒（负向防误杀）", () => {
    setConfigValue("full_position_cap", 0.01);
    expect(getFullPositionCap()).toBe(0.01);
    setConfigValue("full_position_cap", 1e10);
    expect(getFullPositionCap()).toBe(1e10);
  });
});

describe("full_position_cap 优先级链", () => {
  test("运行时参数 > 环境变量 > 配置文件 > 默认值", () => {
    expect(getFullPositionCap()).toBe(50000);

    setConfigValue("full_position_cap", 100000);
    expect(getFullPositionCap()).toBe(100000);

    process.env.LOT_TRADER_FULL_POSITION_CAP = "300000";
    expect(getFullPositionCap()).toBe(300000);

    expect(getFullPositionCap(70000)).toBe(70000);
  });

  test("非法环境变量不覆盖配置文件", () => {
    setConfigValue("full_position_cap", 100000);
    process.env.LOT_TRADER_FULL_POSITION_CAP = "abc";
    expect(getFullPositionCap()).toBe(100000);
  });
});

describe("坏配置文件的容错", () => {
  test.each([
    ["非 JSON", "{not json"],
    ["JSON 数组", "[1,2,3]"],
    ["JSON null", "null"],
  ])("%s：回落默认值，不抛错", (_label, content) => {
    writeFileSync(getConfigPath(), content);
    expect(loadConfig()).toEqual({});
    expect(getFullPositionCap()).toBe(50000);
  });

  test("文件里的非数值 cap 被忽略", () => {
    writeFileSync(getConfigPath(), JSON.stringify({ full_position_cap: "100000" }));
    expect(getFullPositionCap()).toBe(50000);
  });
});

describe("set 之后 position 的 cap 真的变了", () => {
  test("PositionAggregator 读取配置文件里的 cap", async () => {
    const db = new AppDatabase(":memory:");
    try {
      const quotes = new QuoteProvider();
      quotes.getQuotes = async () => ({});

      expect(new PositionAggregator(db.getConnection(), quotes).getFullPositionCap()).toBe(50000);

      setConfigValue("full_position_cap", 100000);
      expect(new PositionAggregator(db.getConnection(), quotes).getFullPositionCap()).toBe(100000);

      const view = await new PositionAggregator(db.getConnection(), quotes).getHierarchicalPositionView();
      expect(view.portfolio_summary.full_position_cap).toBe(100000);
    } finally {
      db.getConnection().close();
    }
  });
});

describe("trade config CLI", () => {
  test("set / get / list 的 --json 输出", async () => {
    const set = await runCli(["config", "set", "full_position_cap", "100000", "--json"]);
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ code: 0, data: { key: "full_position_cap", value: 100000 } });

    const get = await runCli(["config", "get", "full_position_cap", "--json"]);
    expect(get.exitCode).toBe(0);
    expect(JSON.parse(get.stdout)).toMatchObject({ code: 0, data: { key: "full_position_cap", value: 100000 } });

    const list = await runCli(["config", "list", "--json"]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ code: 0, data: { values: { full_position_cap: 100000 } } });
  });

  test("get 未设置的键返回 null", async () => {
    const get = await runCli(["config", "get", "full_position_cap", "--json"]);
    expect(get.exitCode).toBe(0);
    expect(JSON.parse(get.stdout).data.value).toBeNull();
  });

  test("未知键被拒绝且不落盘", async () => {
    const r = await runCli(["config", "set", "fee_rate", "0.0003"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("未知的配置项");
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });

  test.each(["Infinity", "100abc", "-5", "0"])("非法值 %s 被拒绝且不落盘", async (value) => {
    const r = await runCli(["config", "set", "full_position_cap", value]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });

  test("未声明的参数在执行前被拒绝", async () => {
    const r = await runCli(["config", "set", "full_position_cap", "100000", "--bogus"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("未声明的参数 --bogus");
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });
});
