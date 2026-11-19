import { stripVTControlCharacters } from "node:util";
import { readCredential } from "./config.js";

// Provider-controlled display fields must not inject terminal controls or rows.
export function displayText(value) {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 256).trim();
}
import { percentLeft } from "./model.js";
import { parseUsageResponse, quotaRequest } from "./quota.js";

// Errors from fetch, response bodies, JSON parsing and file reads may contain
// secrets. Only locally generated, bounded error categories leave collectors.
function safeError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "request timed out";
  return "request failed";
}

async function mapAccounts(files, collect) {
  const results = new Array(files.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (index < files.length) {
      const current = index++;
      results[current] = await collect(files[current]);
    }
  }));
  return results;
}

export function createCollectors(config, dependencies = {}) {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const credential = (key, file) => readCredential(key, file, dependencies);
  async function getJSON(url, headers, options = {}) {
    const response = await fetcher(url, { ...options, headers, redirect: "error", signal: AbortSignal.timeout(config.timeoutMs) });
    if (!response.ok) return { error: `HTTP ${Number.isInteger(response.status) ? response.status : "error"}` };
    return { body: await response.json() };
  }
  async function fetchGo() {
    if (!config.opencodeGo.enabled) return { enabled: false };
    const key = credential("OPENCODE_GO_API_KEY", config.opencodeGo.apiKeyFile);
    if (!key) return { ok: false, error: "missing API key" };
    try {
      const result = await getJSON("https://opencode.ai/zen/go/v1/usage", { authorization: `Bearer ${key}` });
      if (result.error) return { ok: false, error: result.error };
      const usage = result.body?.usage;
      if (!usage || typeof usage !== "object") return { ok: false, error: "no usage" };
      const window = (name) => {
        const entry = usage[name];
        return entry ? { left: percentLeft(entry.percent), limited: entry.status === "rate-limited", resetsAt: entry.resetsAt } : undefined;
      };
      return { ok: true, rolling: window("rolling"), weekly: window("weekly"), monthly: window("monthly") };
    } catch (error) { return { ok: false, error: safeError(error) }; }
  }
  async function fetchClipProxy() {
    if (!config.cliproxyapi.enabled) return { enabled: false };
    const password = credential("CLIPROXY_MANAGEMENT_PASSWORD", config.cliproxyapi.managementPasswordFile);
    if (!password) return { ok: false, error: "missing management password" };
    const base = config.cliproxyapi.baseUrl;
    try {
      const result = await getJSON(`${base}/v8/management/credentials`, { authorization: `Bearer ${password}` });
      if (result.error) return { ok: false, error: result.error };
      if (!Array.isArray(result.body?.files)) return { ok: false, error: "no account data" };
      const files = result.body.files.filter((file) => file && !file.disabled && (file.provider ?? file.type) === "codex");
      const accounts = await mapAccounts(files, async (file) => {
        const account = {
          account: displayText(file.account ?? file.email ?? file.name ?? "?") || "?", status: displayText(file.status),
          disabled: Boolean(file.disabled), blocked: Boolean(file.quota_blocked),
          cooldowns: Array.isArray(file.cooldowns) ? file.cooldowns.length : 0,
          cooldownReasons: Array.isArray(file.cooldowns) ? file.cooldowns.map((item) => item?.reason ?? item?.code).filter((reason) => typeof reason === "string").map(displayText) : [],
          signals: Object.fromEntries(Object.entries(file.quota?.signals ?? {}).map(([key, value]) => [key, displayText(value)])),
          source: "captured", observedAt: file.quota?.observed_at,
        };
        try {
          const response = await getJSON(`${base}/v8/management/requests/api-call`, {
            authorization: `Bearer ${password}`, "Content-Type": "application/json",
          }, { method: "POST", body: JSON.stringify(quotaRequest(file)) });
          if (response.error) return { ...account, quotaError: response.error };
          const usage = parseUsageResponse(response.body);
          return { ...account, ...usage, plan: displayText(usage.plan), source: "live", observedAt: new Date().toISOString() };
        } catch (error) { return { ...account, quotaError: safeError(error) }; }
      });
      accounts.sort((a, b) => a.account.localeCompare(b.account));
      return { ok: true, accounts };
    } catch (error) { return { ok: false, error: safeError(error) }; }
  }
  let costPending;
  let lastCost;
  function fetchProjectCosts() {
    if (!config.openaiProjectCosts.enabled) return Promise.resolve({ enabled: false });
    if (costPending) return costPending;
    costPending = (async () => {
      let error;
      const token = credential("OPENAI_PROJECT_COSTS_TOKEN", config.openaiProjectCosts.tokenFile);
      if (!token) error = "missing broker token";
      else try {
        const result = await getJSON(config.openaiProjectCosts.endpoint, { authorization: `Bearer ${token}` }, { method: "GET" });
        if (result.error) error = result.error;
        else {
          const { amount, currency, periodStart, periodEnd, observedAt } = result.body ?? {};
          const utc = (value) => {
            if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
            const time = Date.parse(value);
            if (!Number.isFinite(time)) return false;
            const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = "") => `.${fraction.padEnd(3, "0")}Z`);
            return new Date(time).toISOString() === normalized;
          };
          const now = (dependencies.now ?? Date.now)();
          const start = new Date(now); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
          // Allow modest broker/client clock skew without accepting an arbitrary future cutoff.
          if (typeof amount !== "number" || !Number.isFinite(amount) || currency !== "USD" ||
              !utc(periodStart) || !utc(periodEnd) || !utc(observedAt) || Date.parse(periodStart) !== start.getTime() ||
              Date.parse(periodEnd) <= start.getTime() || Date.parse(periodEnd) > now + 300_000 ||
              Date.parse(observedAt) < Date.parse(periodEnd)) error = "invalid cost response";
          else return lastCost = { ok: true, amount, currency, periodStart, periodEnd, observedAt };
        }
      } catch (caught) { error = safeError(caught); }
      const now = (dependencies.now ?? Date.now)();
      const start = new Date(now); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
      if (lastCost && Date.parse(lastCost.periodStart) === start.getTime()) return { ...lastCost, stale: true, error };
      lastCost = undefined;
      return { ok: false, error };
    })().finally(() => { costPending = undefined; });
    return costPending;
  }
  return { fetchGo, fetchClipProxy, fetchProjectCosts };
}
