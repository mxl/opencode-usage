import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function expandHome(path, home = homedir()) {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function configPath(env = process.env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode-usage", "config.json");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateConfig(input = {}) {
  if (!object(input)) throw new Error("Config must be an object");
  const interval = (key, fallback, minimum, maximum) => {
    const value = input[key] === undefined ? fallback : input[key];
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${key}`);
    return value;
  };
  const source = (key, fileKey) => {
    const value = input[key] === undefined ? {} : input[key];
    if (!object(value) || (value.enabled !== undefined && typeof value.enabled !== "boolean")) throw new Error(`Invalid ${key}`);
    if (value[fileKey] !== undefined && (typeof value[fileKey] !== "string" || !value[fileKey].trim())) throw new Error(`Invalid ${key} secret file`);
    // Explicit absolute or home-relative files only: never search the working directory.
    if (value[fileKey] && !isAbsolute(value[fileKey]) && !value[fileKey].startsWith("~/")) throw new Error(`Invalid ${key} secret file path`);
    return { enabled: value.enabled ?? false, ...(value[fileKey] ? { [fileKey]: value[fileKey] } : {}) };
  };
  const opencodeGo = source("opencodeGo", "apiKeyFile");
  const cliproxyapi = source("cliproxyapi", "managementPasswordFile");
  const baseUrl = input.cliproxyapi?.baseUrl === undefined ? "http://127.0.0.1:4003" : input.cliproxyapi.baseUrl;
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error("Invalid cliproxyapi baseUrl"); }
  if (typeof baseUrl !== "string" || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid cliproxyapi baseUrl");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("CLIProxyAPI requires HTTPS except on loopback");
  cliproxyapi.baseUrl = baseUrl.replace(/\/+$/, "");
  const openaiProjectCosts = source("openaiProjectCosts", "tokenFile");
  const endpoint = input.openaiProjectCosts?.endpoint;
  if (endpoint !== undefined || openaiProjectCosts.enabled) {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error("Invalid openaiProjectCosts endpoint"); }
    if (typeof endpoint !== "string" || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Invalid openaiProjectCosts endpoint");
    openaiProjectCosts.endpoint = endpoint;
  }
  return { refreshMs: interval("refreshMs", 60_000, 1000, 86_400_000), timeoutMs: interval("timeoutMs", 8000, 1, 300_000), opencodeGo, cliproxyapi, openaiProjectCosts };
}

export function loadConfig({ env = process.env, home = homedir(), readFile = readFileSync } = {}) {
  try {
    return { config: validateConfig(JSON.parse(readFile(configPath(env, home), "utf8"))) };
  } catch (error) {
    if (error?.code === "ENOENT") return { config: validateConfig() };
    // Do not expose parser messages: malformed input may contain credentials.
    return { config: validateConfig(), error: "Cannot load config.json. Check file permissions, JSON and configuration values." };
  }
}

export function readCredential(envKey, file, { env = process.env, home = homedir(), readFile = readFileSync } = {}) {
  const value = env[envKey]?.trim();
  if (value) return value;
  if (!file) return undefined;
  try { return readFile(expandHome(file, home), "utf8").trim() || undefined; }
  catch { return undefined; }
}
