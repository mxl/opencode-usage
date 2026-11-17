import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as model from "./model.js";
import { percentageParts } from "./colors.js";
import { createCollectors } from "./collectors.js";
import { validateConfig } from "./config.js";

test("click and command open dashboard; back preserves session; refresh and cleanup work", async () => {
  const slots = [];
  const layers = [];
  let route = { type: "session", sessionID: "test-session" };
  let registered;
  let routeRemoved = false;
  let requests = 0;
  const context = vm.createContext({
    ...model, percentageParts, Date, Promise, AbortSignal,
    loadConfig: () => ({ config: validateConfig({ opencodeGo: { enabled: true }, cliproxyapi: { enabled: true } }) }),
    createCollectors: (config) => createCollectors(config, { env: { OPENCODE_GO_API_KEY: 'fake-test-key', CLIPROXY_MANAGEMENT_PASSWORD: 'fake-test-key' }, fetch: (...args) => context.fetch(...args) }),
    jsx: (type, props) => ({ type, props }), For: 'For',
    createSignal: (initial) => { let value = initial; return [() => value, (next) => { value = next; }]; },
    setInterval: () => ({ unref() {} }), clearInterval() {},
    fetch: async (url, options) => {
      requests++;
      if (url.includes('/requests/api-call')) {
        const request = JSON.parse(options.body);
        assert.equal(request.method, 'GET');
        assert.equal(request.authIndex, 'test-index');
        assert.equal(request.header.Authorization, 'Bearer $TOKEN$');
        return { ok: true, json: async () => ({ status_code: 200, body: JSON.stringify({rate_limit:{primary_window:{used_percent:12,limit_window_seconds:18000}}}) }) };
      }
      return { ok: true, json: async () => url.includes('/credentials')
        ? { files: [{ account: 'test@example.org', provider: 'codex', auth_index: 'test-index', disabled: false, quota: { signals: {} } }] }
        : { usage: { rolling: { percent: 20, resetsAt: '2030-01-01T00:00:00Z' } } } };
    },
  });
  const source = readFileSync(new URL('./tui.js', import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?;\s*$/gm, '').replace('export default {', 'globalThis.plugin = {');
  vm.runInContext(source, context);
  const ctx = {
    theme: { text: { base: 'white', muted: 'gray' } },
    keymap: { layer: (factory) => layers.push(factory()) },
    ui: {
      slot: (claim) => { const slot = { claim, removed: false }; slots.push(slot); return () => { slot.removed = true; }; },
      router: {
        register: (definition) => { registered = definition; return () => { routeRemoved = true; }; },
        current: () => route,
        navigate: (next) => { route = next; },
      },
    },
  };
  const dispose = context.plugin.setup(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  const home = slots.findLast(({ claim }) => claim.before === 'home.footer');
  const bar = home.claim.render({});
  assert.ok(bar.props.children.flatMap((child) => child.props.children.map((span) => span.props.children)).join('').includes('GO 80:-:-'));
  const click = bar.props.onMouseDown;
  click({ button: 2 });
  assert.equal(route.type, 'session');
  click({ button: 0, isDragging: true });
  assert.equal(route.type, 'session');
  click({ button: 0 });
  assert.equal(route.name, 'opencode-usage.limits.dashboard');
  const page = registered.render();
  assert.equal(page.props.children[0].props.children, 'Limits — remaining quota');
  const commands = layers.at(-1).commands;
  commands.find(({bind}) => bind === 'escape').run();
  assert.equal(route.sessionID, 'test-session');
  layers[0].commands[0].run();
  assert.equal(route.type, 'plugin');
  commands.find(({bind}) => bind === 'r').run();
  commands.find(({bind}) => bind === 'r').run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 6, 'concurrent refreshes should coalesce');
  const rows = page.props.children[2].props.children.props.each;
  assert.ok(rows.some((row) => row.includes('test@example.org')));
  assert.ok(rows.some((row) => row.includes('5h:88%')));
  assert.ok(rows.some((row) => row.includes('Source: live usage endpoint')));
  dispose();
  assert.ok(slots.every(({removed}) => removed));
  assert.ok(routeRemoved);
});
