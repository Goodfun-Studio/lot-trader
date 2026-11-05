/**
 * Configuration management for lot-trader
 * Persists user settings to ~/.lot-trader/config.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
  full_position_cap?: number;
  default_account_id?: string;
  fee_rate?: number;
}

const CONFIG_DIR = join(homedir(), ".lot-trader");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/**
 * Load config from file, return empty object if file doesn't exist
 */
export function loadConfig(): Config {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return {};
    }
    const content = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    console.error(`Warning: Failed to load config from ${CONFIG_FILE}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Save config to file, creating directory if needed
 */
export function saveConfig(config: Config): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    throw new Error(`Failed to save config to ${CONFIG_FILE}: ${(err as Error).message}`);
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
  } else if (key === "fee_rate") {
    if (typeof value !== "number" || !isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`${key} 必须是 0 到 1 之间的正数`);
    }
  } else if (key === "default_account_id") {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${key} 必须是非空字符串`);
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
  if (configValue !== undefined && configValue > 0) {
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
    default_account_id: "默认账户 ID，用于命令行操作时的默认账户",
    fee_rate: "交易费率（小数形式），如 0.0003 表示万三。默认: 0.0003",
  };
}
