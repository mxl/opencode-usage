import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as model from "./model.js";
import { compactPercentageParts, percentageParts } from "./colors.js";
import { createCollectors } from "./collectors.js";
import { validateConfig } from "./config.js";

test("click and command open dashboard; back preserves session; refresh and cleanup work", async () => {
  const slots = [];
  const layers = [];
  let terminalWidth = 200;
  let route = { type: "session", sessionID: "test-session" };
  let registered;
  let routeRemoved = false;
  let requests = 0;
  let goUsed = 20;
  const context = vm.createContext({
    ...model, compactPercentageParts, percentageParts, Date, Promise, AbortSignal, queueMicrotask,
    loadConfig: () => ({ config: validateConfig({ opencodeGo: { enabled: true }, cliproxyapi: { enabled: true } }) }),
    createCollectors: (config) => createCollectors(config, { env: { OPENCODE_GO_API_KEY: 'fake-test-key', CLIPROXY_MANAGEMENT_PASSWORD: 'fake-test-key' }, fetch: (...args) => context.fetch(...args) }),
    jsx: (type, props) => ({ type, props }), For: 'For',
    useTerminalDimensions: () => () => ({ width: terminalWidth, height: 30 }),
    createSignal: (initial) => { let value = initial; return [() => value, (next) => { value = next; }]; },
    setInterval: () => ({ unref() {} }), clearInterval() {},
    fetch: async (url, options) => {
      requests++;
      if (url.includes('/requests/api-call')) {
        const request = JSON.parse(options.body);
        assert.equal(request.method, 'GET');
        assert.ok(['test-index', 'other-index'].includes(request.authIndex));
        assert.equal(request.header.Authorization, 'Bearer $TOKEN$');
        return { ok: true, json: async () => ({ status_code: 200, body: JSON.stringify({rate_limit:{primary_window:{used_percent:request.authIndex === 'test-index' ? 95 : 12,limit_window_seconds:18000}}}) }) };
      }
      return { ok: true, json: async () => url.includes('/credentials')
        ? { files: [{ account: 'test@example.org', provider: 'codex', auth_index: 'test-index', disabled: false, quota: { signals: {} } }, { account: 'other@example.org', provider: 'codex', auth_index: 'other-index', disabled: false, quota: { signals: {} } }] }
        : { usage: { rolling: { percent: goUsed, resetsAt: '2030-01-01T00:00:00Z' } } } };
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
  assert.equal(bar.props.width, undefined, 'bar must not claim the full footer row width');
  assert.ok(bar.props.children.flatMap((child) => child.props.children.map((span) => span.props.children)).join('').includes('GO 80:-:-'));
  assert.equal(bar.props.children.length, 3, 'each account remains a separate wrapping group');
  const lastAccount = bar.props.children[2].props.children;
  assert.equal(lastAccount.map((span) => span.props.children).join(''), '  TE 5:-:-');
  assert.equal(lastAccount.find((span) => span.props.children === '5').props.style.fg, '#ff6b6b');
  assert.equal(bar.props.flexWrap, 'wrap');
  const slotCount = slots.length;
  const text = () => bar.props.children.flatMap((child) => child.props.children.map((span) => span.props.children)).join('');
  const full = text();
  // Narrow terminal: the bar re-renders through the getter, not a remount.
  // For w >= 56 the host reserve is 28, so available = w - 36.
  terminalWidth = full.length - 1 + 36;
  assert.equal(text(), 'GO 80  OT 88  TE 5');
  assert.equal(bar.props.children[2].props.children.find((span) => span.props.children === '5').props.style.fg, '#ff6b6b');
  terminalWidth = full.length + 36;
  assert.equal(text(), full, 'full layout returns once the terminal widens again');
  terminalWidth = 20;
  assert.equal(bar.props.children.length, 3, 'narrow layout retains whole account groups');
  assert.equal(slots.length, slotCount, 'resizing does not remount slots');
  terminalWidth = 200;
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
  goUsed = 91;
  commands.find(({bind}) => bind === 'r').run();
  commands.find(({bind}) => bind === 'r').run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 8, 'concurrent refreshes should coalesce');
  assert.equal(slots.length, slotCount, 'refreshing does not remount slots');
  assert.equal(text(), 'GO 9:-:-  OT 88:-:-  TE 5:-:-', 'mounted bar reflects fresh quota; wide terminal stays full');
  assert.equal(bar.props.children[0].props.children.find((span) => span.props.children === '9').props.style.fg, '#ff6b6b');
  const rows = page.props.children[2].props.children.props.each;
  assert.ok(rows.some((row) => row.includes('test@example.org')));
  assert.ok(rows.some((row) => row.includes('5h:5%')));
  assert.ok(rows.some((row) => row.includes('Source: live usage endpoint')));
  dispose();
  assert.ok(slots.every(({removed}) => removed));
  assert.ok(routeRemoved);
});
