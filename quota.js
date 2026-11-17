import { Buffer } from "node:buffer";
import { percentLeft } from "./model.js";

// Mirrors the management UI's account selection without exporting OAuth tokens.
export function chatgptAccountId(file) {
  const objects = [file, file.metadata, file.attributes].filter((value) => value && typeof value === "object");
  for (const object of objects) {
    const id = object.chatgpt_account_id ?? object.chatgptAccountId;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  for (const object of objects) {
    let token = object.id_token;
    if (typeof token === "string") {
      try { token = JSON.parse(token); }
      catch {
        try { token = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
        catch { continue; }
      }
    }
    const id = token?.chatgpt_account_id ?? token?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
}

export function parseUsageResponse(response, now = Date.now()) {
  const code = Number(response?.status_code);
  if (code < 200 || code >= 300 || !Number.isFinite(code)) throw new Error(`usage HTTP ${code || "unknown"}`);
  const body = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
  const rate = body?.rate_limit ?? body?.rateLimit;
  if (!rate || typeof rate !== "object") throw new Error("usage windows unavailable");
  const windows = [rate.primary_window ?? rate.primaryWindow, rate.secondary_window ?? rate.secondaryWindow]
    .filter(Boolean).flatMap((entry) => {
      const seconds = Number(entry.limit_window_seconds ?? entry.limitWindowSeconds);
      if (!Number.isFinite(seconds) || seconds <= 0) return [];
      const label = seconds === 604800 ? "W" : seconds >= 2419200 && seconds <= 2678400 ? "M"
        : seconds % 86400 === 0 ? `${seconds / 86400}d`
        : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${seconds / 60}m`;
      const rawReset = entry.reset_at ?? entry.resetAt;
      const numericReset = rawReset === null || rawReset === "" ? NaN : Number(rawReset);
      let reset = Number.isFinite(numericReset) && numericReset > 0
        ? numericReset * (numericReset < 1e11 ? 1000 : 1)
        : typeof rawReset === "string" ? Date.parse(rawReset) : NaN;
      const relative = entry.reset_after_seconds ?? entry.resetAfterSeconds;
      if (!Number.isFinite(reset) && relative !== undefined && relative !== null && Number.isFinite(Number(relative))) {
        reset = now + Math.max(0, Number(relative)) * 1000;
      }
      return [{ label, left: percentLeft(entry.used_percent ?? entry.usedPercent),
        resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : undefined }];
    });
  const usageLimitReasons = [];
  if (rate.limit_reached === true) usageLimitReasons.push("limit_reached=true");
  if (rate.allowed === false) usageLimitReasons.push("allowed=false");
  return { windows, plan: body.plan_type ?? body.planType, usageLimited: usageLimitReasons.length > 0, usageLimitReasons };
}

export function quotaRequest(file) {
  const authIndex = file.auth_index ?? file.authIndex;
  if (authIndex === undefined || authIndex === null || String(authIndex).trim() === "") throw new Error("missing auth index");
  const id = chatgptAccountId(file);
  return {
    authIndex: String(authIndex), method: "GET", url: "https://chatgpt.com/backend-api/wham/usage",
    header: {
      Authorization: "Bearer $TOKEN$", "Content-Type": "application/json",
      "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
      ...(id ? { "Chatgpt-Account-Id": id } : {}),
    },
  };
}
