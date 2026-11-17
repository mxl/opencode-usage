// Pure presentation helpers. Never receives credential tokens.
export function percentLeft(used) {
  if (used === undefined || used === null || used === "") return undefined;
  const value = Number(used);
  return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, 100 - value))) : undefined;
}

export function countdown(resetsAt, now = Date.now()) {
  const time = typeof resetsAt === "string" ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(time)) return undefined;
  if (time <= now) return "due";
  const minutes = Math.ceil((time - now) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return `${days}d${hours ? `${hours}h` : ""}`;
  if (hours) return `${hours}h${rest ? `${rest}m` : ""}`;
  return `${minutes}m`;
}

export function codexWindows(signals = {}) {
  return ["Primary", "Secondary"].flatMap((side) => {
    const prefix = `X-Codex-${side}-`;
    const minutes = Number(signals[`${prefix}Window-Minutes`]);
    if (!Number.isFinite(minutes) || minutes <= 0) return [];
    const label = minutes === 10080 ? "W" : minutes === 43200 ? "M"
      : minutes % 1440 === 0 ? `${minutes / 1440}d`
      : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
    const reset = Number(signals[`${prefix}Reset-At`]);
    return [{ label, left: percentLeft(signals[`${prefix}Used-Percent`]),
      resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined }];
  });
}

export function accountLabels(accounts) {
  const used = new Set(["GO"]);
  return accounts.map((account) => {
    const [local, domain = ""] = account.account.split("@");
    const base = local.slice(0, 2).toUpperCase() || "?";
    let label = base;
    if (used.has(label)) label = `${base}.${domain.split(".")[0].slice(0, 2).toUpperCase()}`;
    let suffix = 2;
    const candidate = label;
    while (used.has(label)) label = `${candidate}${suffix++}`;
    used.add(label);
    return label;
  });
}

export function goWindows(go) {
  return [["5h", go?.rolling], ["W", go?.weekly], ["M", go?.monthly]]
    .flatMap(([label, window]) => window ? [{ label, ...window }] : []);
}

// The compact bar is always 5h:W:M; dashboard labels and percent signs stay.
function windowText(window, suffix = "") {
  return `${window.label}:${window.left === undefined ? "?" : `${window.left}${suffix}`}`;
}

function compactTriplet(windows, unknown = false) {
  const values = { "5h": "-", W: "-", M: "-" };
  for (const window of windows) {
    if (!(window.label in values)) continue;
    values[window.label] = window.left === undefined ? "?" : String(window.left);
  }
  if (unknown && Object.values(values).every((value) => value === "-")) {
    values["5h"] = values.W = values.M = "?";
  }
  return `${values["5h"]}:${values.W}:${values.M}`;
}

export function compactLine(go, cpa) {
  const goQuota = go?.ok ? goWindows(go) : [];
  const parts = go?.enabled === false ? [] : [!go ? "GO …" : `GO ${compactTriplet(goQuota, !go.ok)}`];
  if (cpa?.enabled === false) return parts.join(" · ") || "Limits · /limits setup";
  if (!cpa) parts.push("CPA …");
  else if (!cpa.ok) parts.push("CPA ?");
  else {
    const labels = accountLabels(cpa.accounts);
    cpa.accounts.forEach((account, index) => {
      const windows = account.windows ?? codexWindows(account.signals);
      const unknown = Boolean(account.quotaError) && windows.length === 0;
      const text = compactTriplet(windows, unknown);
      const fallback = account.source === "captured" && windows.length ? "~" : "";
      parts.push(`${labels[index]} ${text}${fallback}`);
    });
    if (!cpa.accounts.length) parts.push("CPA empty");
  }
  return parts.join(" · ");
}

function cooldownReasonLabel(reason) {
  const labels = {
    credential_quota: "credential quota",
    quota: "quota limit",
    rate_limit: "rate limit",
    rate_limited: "rate limit",
  };
  const key = String(reason ?? "").trim();
  return labels[key] ?? (key.replace(/[_-]+/g, " ").slice(0, 80) || "unspecified");
}

function accountRestrictionLines(account) {
  const lines = [];
  if (account.blocked) lines.push("  Cause: CLIProxyAPI marks the credential quota-blocked.");

  const cooldownCount = Number(account.cooldowns) || 0;
  if (cooldownCount > 0) {
    const counts = new Map();
    for (const item of account.cooldownReasons ?? []) {
      const reason = typeof item === "string" ? item : item?.reason ?? item?.code;
      const label = cooldownReasonLabel(reason);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const reported = [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (reported < cooldownCount) counts.set("other cooldown", (counts.get("other cooldown") ?? 0) + cooldownCount - reported);
    const summary = [...counts].map(([reason, count]) => `${reason}${count > 1 ? ` ×${count}` : ""}`).join(", ");
    lines.push(`  Cause: ${cooldownCount} active cooldown${cooldownCount === 1 ? "" : "s"}${summary ? ` — ${summary}` : ""}.`);
  }

  if (account.usageLimited) {
    const detail = account.usageLimitReasons?.length ? ` (${account.usageLimitReasons.join(", ")})` : "";
    lines.push(`  Cause: live usage endpoint reports the account limit reached${detail}.`);
  }
  const limitedWindows = (account.windows ?? []).filter((window) => window.limited).map((window) => window.label);
  if (limitedWindows.length) lines.push(`  Cause: provider reports rate-limited on ${limitedWindows.join(", ")}.`);
  return lines;
}

export function dashboardLines(go, cpa, updatedAt, now = Date.now(), { refreshMs = 60_000, configError } = {}) {
  const lines = ["All percentages are remaining.  W = weekly · M = monthly", ""];
  if (configError) lines.push(configError, "");
  if (go?.enabled === false && cpa?.enabled === false) {
    return [...lines, "Set up opencode-usage", "Both sources are disabled. No network requests are made.",
      "Create $XDG_CONFIG_HOME/opencode-usage/config.json (default ~/.config/opencode-usage/config.json).",
      "Enable opencodeGo.enabled or cliproxyapi.enabled and supply its credential via environment or an explicit secret file.",
      "See README for configuration examples. Reload the plugin after configuration changes."];
  }
  const detail = (window) => {
    const reset = countdown(window.resetsAt, now);
    return `  ${windowText(window, "%")}    reset ${reset ?? "unknown"}${reset === "due" ? " (awaiting fresh quota)" : ""}`;
  };
  if (go?.enabled !== false) {
    lines.push("GO  OpenCode Go");
    if (!go?.ok) lines.push(`  Unavailable: ${go?.error ?? "loading"}`);
    else {
      const windows = goWindows(go);
      lines.push(...windows.map(detail));
      if (!windows.length) lines.push("  No usage windows reported");
      const limited = windows.filter((window) => window.limited).map((window) => window.label);
      if (limited.length) lines.push(`  Cause: OpenCode Go reports rate-limited on ${limited.join(", ")}.`);
    }
  }
  if (cpa?.enabled !== false) {
    lines.push("", "CLIProxyAPI");
    if (!cpa?.ok) lines.push(`  Unavailable: ${cpa?.error ?? "loading"}`);
    else {
      const labels = accountLabels(cpa.accounts);
      cpa.accounts.forEach((account, index) => {
        const plan = account.plan ?? account.signals?.["X-Codex-Plan-Type"];
        const state = account.disabled ? "disabled" : account.blocked || account.cooldowns || account.usageLimited ? "throttled" : account.status ?? "active";
        lines.push("", `${labels[index]}  ${account.account}  [${state}${plan ? ` · ${plan}` : ""}]`);
        const windows = account.windows ?? codexWindows(account.signals);
        lines.push(...(windows.length ? windows.map(detail) : ["  Remaining quota unavailable — no usage windows returned"]));
        lines.push(...accountRestrictionLines(account));
        if (account.source) {
          const observed = account.observedAt ? ` · observed ${new Date(account.observedAt).toLocaleString()}` : "";
          lines.push(`  Source: ${account.source === "live" ? "live usage endpoint" : "captured headers (may be stale)"}${observed}`);
        }
        if (account.quotaError) lines.push(`  Live quota unavailable: ${account.quotaError}`);
      });
      if (!cpa.accounts.length) lines.push("  No accounts reported");
    }
    lines.push("", "CPA quotas use live usage reads; ~ marks a captured fallback that may be stale.");
  }
  lines.push("Reset due does not imply quota has replenished; no inference is sent to check.",
    updatedAt ? `Last fetched ${new Date(updatedAt).toLocaleTimeString()} · auto-refresh ${refreshMs / 1000}s` : "Fetching limits…");
  return lines;
}
