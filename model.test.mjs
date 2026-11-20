import { test } from "node:test";
import assert from "node:assert/strict";
import { accountLabels, adaptiveGroups, codexWindows, compactLine, countdown, dashboardLines, footerAvailableWidth, percentLeft } from "./model.js";

const signals = {
  "X-Codex-Primary-Window-Minutes": "300",
  "X-Codex-Primary-Used-Percent": "82",
  "X-Codex-Primary-Reset-At": "1893456000",
  "X-Codex-Secondary-Window-Minutes": "10080",
  "X-Codex-Secondary-Used-Percent": "13",
};
const go = { ok: true, rolling: { left: 14 }, weekly: { left: 59 }, monthly: { left: 36 } };
const cpa = { ok: true, accounts: [
  { account: "adam@example.org", signals },
  { account: "chatgpt@one.org", disabled: true },
  { account: "chatgpt@two.org", signals: {} },
] };

test("remaining percentages never invent 100% for missing or malformed data", () => {
  for (const value of [undefined, null, "", "bad", Infinity]) assert.equal(percentLeft(value), undefined);
  assert.equal(percentLeft("82"), 18);
  assert.equal(percentLeft(120), 0);
  assert.equal(percentLeft(-10), 100);
});

test("only real windows appear, with remaining instead of used", () => {
  const windows = codexWindows(signals);
  assert.deepEqual(windows.map(({label, left}) => ({ label, left })), [{ label: "5h", left: 18 }, { label: "W", left: 87 }]);
  assert.equal(windows[0].resetsAt, "2030-01-01T00:00:00.000Z");
  assert.equal(codexWindows({ "X-Codex-Primary-Window-Minutes": "0" }).length, 0);
  assert.equal(codexWindows({ "X-Codex-Primary-Window-Minutes": "300" })[0].left, undefined);
});

test("labels use the first two local characters without deduplication or reserving GO", () => {
  const labels = accountLabels([...cpa.accounts, { account: "chatgpt@two.com" }, { account: "go@example.org" },
    { account: "g@example.org" }, { account: "@example.org" }, { account: "" }]);
  assert.deepEqual(labels, ["AD", "CH", "CH", "CH", "GO", "G", "?", "?"]);
});

test("bar uses fixed 5h:W:M triplets and dashes for absent windows", () => {
  assert.equal(compactLine(go, cpa), "GO 14:59:36  AD 18:87:-  CH -:-:-  CH -:-:-");
  assert.equal(compactLine({ ok: true, rolling: { limited: true, left: 0 } }, { ok: true, accounts: [] }), "GO 0:-:-  CPA empty");
  assert.equal(compactLine({ ok: true, weekly: { left: 59 } }, { ok: true, accounts: [] }), "GO -:59:-  CPA empty");
  assert.equal(compactLine({ ok: true }, { ok: true, accounts: [{ account: "failed@example.org", quotaError: "usage HTTP 403" }] }), "GO -:-:-  FA ?:?:?");
  assert.equal(compactLine({ ok: false }, { ok: false }), "GO ?:?:?  CPA ?");
});

test("GO account labels coexist with OpenCode Go in the bar and dashboard", () => {
  const accounts = { ok: true, accounts: [{ account: "go@example.org", windows: [{ label: "5h", left: 42 }] }] };
  assert.equal(compactLine(go, accounts), "GO 14:59:36  GO 42:-:-");
  assert.equal(adaptiveGroups(go, accounts, 1).join("  "), "GO 14  GO 42");
  assert.ok(dashboardLines(go, accounts).some((line) => line.includes("GO  go@example.org")));
});

test("adaptive bar switches all accounts at the exact full-line width", () => {
  const full = compactLine(go, cpa);
  assert.equal(adaptiveGroups(go, cpa, full.length).join("  "), full);
  assert.equal(adaptiveGroups(go, cpa, full.length + 1).join("  "), full);
  assert.equal(adaptiveGroups(go, cpa, full.length - 1).join("  "), "GO 14  AD 18  CH ?  CH ?");
  assert.equal(adaptiveGroups(go, cpa, 1).length, 4);
});

test("separate row reserves only its horizontal padding", () => {
  assert.equal(footerAvailableWidth(undefined), undefined);
  assert.equal(footerAvailableWidth(100), 96);
  assert.equal(footerAvailableWidth(30, 1), 28);
  assert.equal(footerAvailableWidth(3), 0);
});

test("short bar uses shortest reported interval, not the most restrictive quota", () => {
  const accounts = { ok: true, accounts: [
    { account: "weekly@example.org", windows: [{ label: "M", left: 0 }, { label: "W", left: 63 }] },
    { account: "monthly@example.org", windows: [{ label: "M", left: 100 }], source: "captured" },
    { account: "other@example.org", windows: [{ label: "W", left: 0 }, { label: "90m", left: 88 }] },
    { account: "unknown@example.org", windows: [{ label: "5h" }, { label: "W", left: 50 }] },
  ] };
  assert.equal(adaptiveGroups({ ok: true, weekly: { left: 72 }, monthly: { left: 0 } }, accounts, 1).join("  "),
    "GO 72  WE 63  MO 100~  OT 88  UN ?");
  assert.equal(adaptiveGroups({ enabled: false }, { enabled: false }, 1).join(""), "Limits · /limits setup");
});

test("zero remaining explains quota restrictions without redundant causes", () => {
  const goLimited = { ok: true, rolling: { left: 0, limited: true } };
  const account = {
    account: "blocked@example.org",
    blocked: true,
    plan: "plus",
    cooldowns: 3,
    cooldownReasons: ["credential_quota", "credential_quota", "quota"],
    usageLimited: true,
    usageLimitReasons: ["allowed=false", "limit_reached=true"],
    windows: [{ label: "5h", left: 0 }],
  };
  const cpaLimited = { ok: true, accounts: [account] };
  const compact = compactLine(goLimited, cpaLimited);
  assert.equal(compact, "GO 0:-:-  BL 0:-:-");
  assert.ok(!compact.includes("!"));
  const dashboard = dashboardLines(goLimited, cpaLimited).join("\n");
  assert.ok(!dashboard.includes("!"));
  assert.ok(dashboard.includes("[quota-blocked · plus]"));
  assert.ok(!dashboard.includes("rate-limited"));
  assert.ok(!dashboard.includes("Cause:"));
  assert.ok(!dashboard.includes("OpenAI reports a limit"));
  assert.ok(!dashboard.includes("limit_reached=true"));
  assert.ok(!dashboard.includes("allowed=false"));
});

test("window rate limits appear inline only when remaining is nonzero or unknown", () => {
  const goLimited = { ok: true, rolling: { left: 0, limited: true }, weekly: { left: 42, limited: true }, monthly: { limited: true } };
  const accounts = { ok: true, accounts: [{ account: "limited@example.org", usageLimited: true, windows: [
    { label: "5h", left: 0, limited: true }, { label: "W", left: 12, limited: true }, { label: "M", limited: true },
  ] }] };
  const rows = dashboardLines(goLimited, accounts);
  assert.equal(rows.filter((line) => line.includes("rate-limited")).length, 4);
  assert.equal(rows.filter((line) => line.includes("5h:0%")).length, 2);
  assert.ok(rows.filter((line) => line.includes("5h:0%")).every((line) => !line.includes("rate-limited")));
  for (const value of ["W:42%", "W:12%", "M:?"]) assert.ok(rows.some((line) => line.includes(`${value} · rate-limited`)));
  assert.ok(!rows.some((line) => line.includes("Cause:") || line.includes("OpenAI reports a limit")));
});

test("account status and live limit warning reflect visible explanations", () => {
  const accounts = { ok: true, accounts: [
    { account: "disabled@example.org", disabled: true, blocked: true, plan: "plus", usageLimited: true, windows: [{ label: "5h", left: 0 }] },
    { account: "blocked@example.org", blocked: true, plan: "plus", windows: [] },
    { account: "limited@example.org", usageLimited: true, usageLimitReasons: ["allowed=false", "limit_reached=true"], windows: [{ label: "5h", left: 40 }] },
    { account: "unknown@example.org", usageLimited: true, windows: [{ label: "W" }] },
    { account: "empty@example.org", usageLimited: true, windows: [] },
    { account: "inline@example.org", usageLimited: true, windows: [{ label: "W", left: 20, limited: true }] },
    { account: "zero@example.org", usageLimited: true, windows: [{ label: "5h", left: 30 }, { label: "W", left: 0 }] },
  ] };
  const rows = dashboardLines({ enabled: false }, accounts);
  assert.ok(rows.includes("DI  disabled@example.org  [disabled · plus]"));
  assert.ok(rows.includes("BL  blocked@example.org  [quota-blocked · plus]"));
  assert.ok(rows.includes("LI  limited@example.org  [throttled]"));
  assert.equal(rows.filter((line) => line === "  OpenAI reports a limit.").length, 3);
  assert.ok(!rows.some((line) => /allowed=false|limit_reached=true|CLIProxyAPI marks/.test(line)));
});

test("only completely known quota-only cooldowns are hidden by a visible zero", () => {
  const make = (cooldowns, cooldownReasons, windows) => dashboardLines({ enabled: false }, { ok: true, accounts: [
    { account: "test@example.org", cooldowns, cooldownReasons, windows },
  ] }).join("\n");
  const zero = [{ label: "5h", left: 0 }];
  const nonzero = [{ label: "5h", left: 25 }];
  assert.ok(!make(3, ["credential_quota", "quota", "quota"], zero).includes("active cooldown"));
  assert.ok(make(3, ["credential_quota", "quota", "quota"], nonzero).includes("3 active cooldowns — credential quota, quota limit ×2"));
  assert.ok(make(2, ["quota", "rate_limit"], zero).includes("2 active cooldowns — quota limit, rate limit"));
  assert.ok(make(2, ["quota"], zero).includes("2 active cooldowns — quota limit, other cooldown"));
  assert.ok(make(1, [], zero).includes("1 active cooldown — other cooldown"));
  assert.ok(make(1, ["custom_reason"], zero).includes("1 active cooldown — custom reason"));
  assert.ok(make(1, ["quota"], [{ label: "5h" }]).includes("1 active cooldown — quota limit"));
  assert.ok(make(1, ["quota"], []).includes("1 active cooldown — quota limit"));
});

test("countdowns carry correctly and do not claim replenishment", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(countdown("2030-01-01T02:15:00Z", now), "2h15m");
  assert.equal(countdown("2030-01-01T23:59:59Z", now), "1d");
  assert.equal(countdown("2029-12-31T23:59:59Z", now), "due");
  assert.equal(countdown("bad", now), undefined);
});

test("dashboard includes every identity, status and reset without unnecessary source caveats", () => {
  const text = dashboardLines(go, cpa, Date.now()).join("\n");
  for (const account of cpa.accounts) assert.ok(text.includes(account.account));
  assert.ok(text.indexOf("CH  chatgpt@one.org") < text.indexOf("CH  chatgpt@two.org"));
  assert.ok(text.includes("[disabled]"));
  assert.ok(text.includes("Remaining quota unavailable"));
  assert.ok(!text.includes("may be stale"));
  assert.ok(text.includes("5h:18%"));
});

test("reset due warning stays inline and fetching status is retained", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  const rows = dashboardLines({ ok: true, rolling: { left: 0, resetsAt: "2029-12-31T23:59:00Z" } }, { enabled: false }, undefined, now);
  assert.ok(rows.some((line) => line.includes("reset due (awaiting fresh quota)")));
  assert.ok(!rows.some((line) => line.startsWith("Reset due does not")));
  assert.equal(rows.at(-1), "Fetching limits…");
  assert.ok(dashboardLines(go, { enabled: false }, now, now, { refreshMs: 30_000 }).at(-1).includes("auto-refresh 30s"));
});

test("the percent sign is dashboard-only", () => {
  assert.ok(!compactLine(go, cpa).includes("%"));
  assert.ok(dashboardLines(go, cpa).some((line) => line.includes("5h:18%")));
  assert.ok(dashboardLines(go, cpa).some((line) => line.includes("GO")) && dashboardLines(go, cpa).some((line) => line.includes("5h:14%")));
});
