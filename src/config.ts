/**
 * Configuration management for lot-trader
 * Persists user settings to ~/.lot-trader/config.json
 * (override the directory with $LOT_TRADER_CONFIG_DIR, e.g. for tests).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
  full_position_cap?: number;
}

/** Resolved per call so tests (and users) can redirect it via $LOT_TRADER_CONFIG_DIR. */
export function getConfigDir(): string {
  return process.env.LOT_TRADER_CONFIG_DIR || join(homedir(), ".lot-trader");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

/**
 * Load config from file, return empty object if file doesn't exist.
 * A corrupt file falls back to defaults but says how to fix it.
 */
export function loadConfig(): Config {
  const file = getConfigPath();
  try {
    if (!existsSync(file)) {
      return {};
    }
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level value is not a JSON object");
    }
    return parsed;
  } catch (err) {
    console.error(
      `Warning: 配置文件 ${file} 无法解析（${(err as Error).message}），本次按默认值运行。` +
        `修复方法：删除该文件，或用 'trade config set <key> <value>' 重新写入。`,
    );
    return {};
  }
}

/**
 * Save config to file, creating directory if needed
 */
export function saveConfig(config: Config): void {
  const dir = getConfigDir();
  const file = getConfigPath();
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write to a temp file, then rename: a crash mid-write never leaves a truncated config.
    const tmpFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o644 });
    renameSync(tmpFile, file);
  } catch (err) {
    throw new Error(`Failed to save config to ${file}: ${(err as Error).message}`);
  }
}

/**
 * Get a single config value
 */
export function getConfigValue(key: keyof Config): any {
  const config = loadConfig();
  return config[key];
}

/**
 * Set a single config value
 */
export function setConfigValue(key: keyof Config, value: any): void {
  const config = loadConfig();
  
  // Validate value based on key
  if (key === "full_position_cap") {
    if (typeof value !== "number" || !isFinite(value) || value <= 0 || value > 1e10) {
      throw new Error(`${key} 必须是一个正数且不超过 100 亿`);
    }
  }
  
  config[key] = value;
  saveConfig(config);
}

/**
 * Get full_position_cap with fallback chain:
 * 1. Runtime override
 * 2. Environment variable (temporary override)
 * 3. Config file (persistent)
 * 4. Default 50000
 */
export function getFullPositionCap(runtimeOverride?: number): number {
  if (runtimeOverride !== undefined && runtimeOverride > 0) {
    return runtimeOverride;
  }
  
  // Environment variable has higher priority than config file (temporary override)
  if (process.env.LOT_TRADER_FULL_POSITION_CAP) {
    const envValue = parseFloat(process.env.LOT_TRADER_FULL_POSITION_CAP);
    if (!isNaN(envValue) && envValue > 0) {
      return envValue;
    }
  }
  
  const configValue = getConfigValue("full_position_cap");
  if (typeof configValue === "number" && isFinite(configValue) && configValue > 0) {
    return configValue;
  }
  
  return 50000;
}

/**
 * List all valid config keys and their descriptions
 */
export function getConfigSchema(): Record<keyof Config, string> {
  return {
    full_position_cap: "单标满仓额度（元），用于计算仓位占比。默认: 50000",
  };
}
