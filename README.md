# opencode-usage

A clickable remaining-quota bar and `/limits` dashboard for the OpenCode TUI.
OpenCode Go, CLIProxyAPI and OpenAI project spend are independent, optional sources; **all are disabled by default**.
No inference requests, credential changes, quota-reset actions or account mutations are sent.

## Local installation

The source is available on [GitHub](https://github.com/mxl/opencode-usage). The package is not published to npm yet. Clone it locally; no wrapper command or special OpenCode invocation is required.

```sh
git clone https://github.com/mxl/opencode-usage.git
```

Add the **absolute package directory** to the `plugins` array in OpenCode's global `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`), merging with your existing settings:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/absolute/path/to/opencode-usage"]
}
```

The package exposes `./tui` and uses the plain default `{ id, setup }` plugin interface compatible with OpenCode 2.2.7 and 2.3.0. Solid and OpenTUI are provided by OpenCode; no build, dependency installation or bundling is required. OpenCode reloads `cli.json` plugin changes automatically. Reload the plugin (for example with `/reload`) after changing opencode-usage configuration, which is loaded during setup. Remove the local package entry to uninstall. Do not also load the old limits plugin: both register `/limits`.

## Configuration

Create `~/.config/opencode-usage/config.json`, or `$XDG_CONFIG_HOME/opencode-usage/config.json` when `XDG_CONFIG_HOME` is set. Missing configuration disables all sources without reading secrets or making requests. Invalid/unreadable configuration disables all sources and shows a sanitized setup error in `/limits`.

Start with [config.example.json](config.example.json). Enable only the sources you use:

```json
{
  "refreshMs": 60000,
  "timeoutMs": 8000,
  "opencodeGo": { "enabled": true },
  "cliproxyapi": { "enabled": true, "baseUrl": "http://127.0.0.1:4003" }
}
```

Supply credentials in the environment inherited by your normal OpenCode process:

```sh
export OPENCODE_GO_API_KEY='your-go-api-key'
export CLIPROXY_MANAGEMENT_PASSWORD='your-management-password'
```

Alternatively configure explicit secret files containing only their raw credential (surrounding whitespace is trimmed):

```json
{
  "opencodeGo": {
    "enabled": true,
    "apiKeyFile": "~/.config/opencode-usage/secrets/go-key"
  },
  "cliproxyapi": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:4003",
    "managementPasswordFile": "~/.config/opencode-usage/secrets/cpa-password"
  }
}
```

Use restrictive permissions, for example `chmod 600` on secret files. Explicit files follow symlinks; file ownership, permissions and symlink targets are the operator's responsibility. Nonempty environment credentials take precedence over files. Empty/whitespace environment values fall back to the explicitly configured file. Only absolute paths or `~/` paths are accepted; `~` expansion uses the current user's home. There is **no implicit secret-file search, .env loading, shell expansion, or credential discovery**. Files are never read for disabled sources. Keep credentials out of version control.

`refreshMs` defaults to 60000 (integer, 1000–86400000); `timeoutMs` defaults to 8000 (integer, 1–300000), applied per HTTP request. At most four account reads run concurrently. Repeated refreshes coalesce. Configuration is loaded at startup; credentials are read on refresh. Use HTTPS for remote CLIProxyAPI servers; plain HTTP is allowed only for localhost, 127.0.0.1 or ::1. URLs cannot embed credentials, queries or fragments. Authenticated requests reject redirects.

### OpenAI project spend (optional)

Run a separate read-only project-cost broker and configure its **full endpoint**. The broker must hold the OpenAI Admin API key and expose a distinct, read-only bearer token; never supply the Admin key to this plugin. For example, to enable only this source:

```json
{
  "openaiProjectCosts": {
    "enabled": true,
    "endpoint": "http://127.0.0.1:4097/v1/openai/project-costs",
    "tokenFile": "~/.config/opencode-usage/secrets/project-costs-token"
  }
}
```

Alternatively set `OPENAI_PROJECT_COSTS_TOKEN` in OpenCode's environment; it takes precedence over `tokenFile`. Use restrictive file permissions as above. The endpoint must use HTTPS, or HTTP on localhost, 127.0.0.1 or ::1; embedded credentials, queries, fragments and redirects are rejected. The broker must return JSON `{ "amount": 12.34, "currency": "USD", "periodStart": "2026-11-01T00:00:00Z", "periodEnd": "2026-11-19T12:00:00Z", "observedAt": "2026-11-19T12:00:00Z" }`, with UTC timestamps, the current UTC month start, an exclusive cutoff after the start, and an observation at or after the cutoff. The cutoff may be up to five minutes ahead of the local clock to allow for clock skew. This source is disabled by default; setting it up does not activate a broker or modify OpenAI/LiteLLM configuration.

Project spend appears only in `/limits`, not the compact quota bar. It includes direct OpenAI API charges for the broker's configured project, including usage through LiteLLM; it is not a remaining balance, LiteLLM estimate, or Codex quota. It is fetched only on dashboard open and manual refresh, not on the quota auto-refresh timer. Billing data may lag. On failure, the last successful same-month amount remains in TUI memory with its original fetched timestamp and a stale marker; otherwise it is unavailable. Nothing is persisted.

## Reading the display

Click the bar or run `/limits` for the full dashboard. `Esc` returns to the prior page/session; `R` refreshes.

- When space permits, compact values occupy **5h:W:M** positions: `GO 80:40:-` means 80% five-hour, 40% weekly, no monthly window reported. In narrower bars every account instead shows its shortest reported interval, e.g. `GO 80  AA 63`; groups wrap if needed. Longer-window restrictions can be hidden in this view—open the dashboard to see all windows.
- Account labels are the first two characters before `@`, uppercased, or `?` if empty. Labels can repeat, including `GO`; the dashboard shows full account identities.
- `-` means absent/not reported; `?` means unknown or unavailable. An enabled source failure is shown without hiding other sources.
- Each numeric value is independently colored: below 10% red, below 30% yellow, otherwise the theme's normal text color. Account labels remain neutral. No `!` restriction markers are appended.
- `~` marks captured-header fallback quota, which may be stale. The dashboard explains live/captured sources, restriction causes, quota blocks, cooldowns and resets.
- A reset marked `due` is not proof quota replenished; no inference is sent to test it.
- Disabled sources are hidden, not shown as failures. With quota sources disabled the bar is a muted setup link; `/limits` also explains setup when every source is disabled.

## Supported data and security

OpenCode Go reads `https://opencode.ai/zen/go/v1/usage` with its API key.

CLIProxyAPI integration targets **v8 management endpoints**, not generic OpenAI-compatible proxies. It reads `GET /v8/management/credentials`, selects **Codex accounts only**, and sends `POST /v8/management/requests/api-call` containing a **GET** to the fixed `https://chatgpt.com/backend-api/wham/usage` quota URL. The upstream header uses the literal `Bearer $TOKEN$` placeholder, resolved by CLIProxyAPI, plus the selected auth index and optional account ID. The POST is a management read proxy, not an inference or mutation call. Other providers are not queried or displayed. CLIProxyAPI must expose these endpoints and allow the configured management password; an inference API key is not a management password.

Only read-only usage requests are implemented, but management credentials can confer broader server privileges. Prefer a trusted local server or protected HTTPS endpoint. Account identifiers and quota metadata are visible in the dashboard; do not share screenshots if they contain personal data. The plugin does not log tokens, response bodies or raw exception messages, and does not persist usage/account data. Server-returned account labels and metadata are displayed; treat your server as trusted. Errors are limited to sanitized categories and HTTP status codes.

## Development

Requires Node.js 20 or newer. No dependencies are needed for the tests:

```sh
npm test
npm pack --dry-run
```

Tests use synthetic fixtures and mocked network/filesystem operations; no live accounts, inference or credentials are needed. TUI tests replace host imports in a VM harness. `config.js` handles validated configuration and explicit credential resolution; `collectors.js` handles requests; `quota.js`, `model.js`, and `colors.js` handle quota parsing and presentation; `tui.js` integrates with OpenCode. Package contents are allowlisted; CI only tests and previews packaging, never publishes.

MIT © 2026 Michael Ledin.
