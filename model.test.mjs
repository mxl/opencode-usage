import { test } from "node:test";
import assert from "node:assert/strict";
import { accountLabels, codexWindows, compactLine, countdown, dashboardLines, percentLeft } from "./model.js";

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

test("unique labels resolve identical local names and reserve GO", () => {
  const labels = accountLabels([...cpa.accounts, { account: "chatgpt@two.com" }, { account: "go@example.org" }]);
  assert.equal(new Set(labels).size, 5);
  assert.deepEqual(labels, ["AD", "CH", "CH.TW", "CH.TW2", "GO.EX"]);
});

test("bar uses fixed 5h:W:M triplets and dashes for absent windows", () => {
  assert.equal(compactLine(go, cpa), "GO 14:59:36 · AD 18:87:- · CH -:-:- · CH.TW -:-:-");
  assert.equal(compactLine({ ok: true, rolling: { limited: true, left: 0 } }, { ok: true, accounts: [] }), "GO 0:-:- · CPA empty");
  assert.equal(compactLine({ ok: true, weekly: { left: 59 } }, { ok: true, accounts: [] }), "GO -:59:- · CPA empty");
  assert.equal(compactLine({ ok: true }, { ok: true, accounts: [{ account: "failed@example.org", quotaError: "usage HTTP 403" }] }), "GO -:-:- · FA ?:?:?");
  assert.equal(compactLine({ ok: false }, { ok: false }), "GO ?:?:? · CPA ?");
});

test("compact status omits exclamation marks while dashboard spells out restriction causes", () => {
  const goLimited = { ok: true, rolling: { left: 0, limited: true } };
  const account = {
    account: "blocked@example.org",
    blocked: true,
    cooldowns: 3,
    cooldownReasons: ["credential_quota", "credential_quota", "quota"],
    usageLimited: true,
    usageLimitReasons: ["allowed=false", "limit_reached=true"],
    windows: [{ label: "5h", left: 0 }],
  };
  const cpaLimited = { ok: true, accounts: [account] };
  const compact = compactLine(goLimited, cpaLimited);
  assert.equal(compact, "GO 0:-:- · BL 0:-:-");
  assert.ok(!compact.includes("!"));
  const dashboard = dashboardLines(goLimited, cpaLimited).join("\\n");
  assert.ok(!dashboard.includes("!"));
  assert.ok(dashboard.includes("Cause: OpenCode Go reports rate-limited on 5h."));
  assert.ok(dashboard.includes("Cause: CLIProxyAPI marks the credential quota-blocked."));
  assert.ok(dashboard.includes("3 active cooldowns — credential quota ×2, quota limit."));
  assert.ok(dashboard.includes("limit_reached=true, allowed=false") || dashboard.includes("allowed=false, limit_reached=true"));
});

test("countdowns carry correctly and do not claim replenishment", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(countdown("2030-01-01T02:15:00Z", now), "2h15m");
  assert.equal(countdown("2030-01-01T23:59:59Z", now), "1d");
  assert.equal(countdown("2029-12-31T23:59:59Z", now), "due");
  assert.equal(countdown("bad", now), undefined);
});

test("dashboard includes every identity, status, reset and stale-data caveat", () => {
  const text = dashboardLines(go, cpa, Date.now()).join("\n");
  for (const account of cpa.accounts) assert.ok(text.includes(account.account));
  assert.ok(text.includes("[disabled]"));
  assert.ok(text.includes("Remaining quota unavailable"));
  assert.ok(text.includes("may be stale"));
  assert.ok(text.includes("5h:18%"));
});

test("the percent sign is dashboard-only", () => {
  assert.ok(!compactLine(go, cpa).includes("%"));
  assert.ok(dashboardLines(go, cpa).some((line) => line.includes("5h:18%")));
  assert.ok(dashboardLines(go, cpa).some((line) => line.includes("GO")) && dashboardLines(go, cpa).some((line) => line.includes("5h:14%")));
});
