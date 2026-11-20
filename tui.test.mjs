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
    jsx: (type, props) => ({ type, props }), For: 'For', Show: 'Show',
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
  assert.equal(slots.length, 1);
  assert.equal(slots[0].claim.append, 'app', 'app slot is below the route, outside the prompt status row');
  const visibility = slots[0].claim.render({});
  assert.equal(visibility.props.when, true, 'session route displays the bar');
  const bar = visibility.props.children;
  assert.equal(bar.props.width, '100%', 'bar measures the allocated app-slot width, not its content');
  assert.equal(bar.props.paddingLeft, 2);
  assert.equal(bar.props.paddingRight, 2);
  const setSlotWidth = async (width) => {
    bar.props.onSizeChange.call({ width });
    await new Promise((resolve) => queueMicrotask(resolve));
  };
  await setSlotWidth(200);
  assert.ok(bar.props.children.flatMap((child) => child.props.children.map((span) => span.props.children)).join('').includes('GO 80:-:-'));
  assert.equal(bar.props.children.length, 3, 'each account remains a separate wrapping group');
  const lastAccount = bar.props.children[2].props.children;
  assert.equal(lastAccount.map((span) => span.props.children).join(''), '  TE 5:-:-');
  assert.equal(lastAccount.find((span) => span.props.children === '5').props.style.fg, '#ff6b6b');
  assert.equal(bar.props.flexWrap, 'wrap');
  const slotCount = slots.length;
  const text = () => bar.props.children.flatMap((child) => child.props.children.map((span) => span.props.children)).join('');
  const full = text();
  // The app slot can be narrower than the terminal (e.g. a vertical tab rail).
  // Only its two columns of padding on each side are reserved.
  await setSlotWidth(full.length - 1 + 4);
  assert.equal(text(), 'GO 80  OT 88  TE 5');
  assert.equal(bar.props.children[2].props.children.find((span) => span.props.children === '5').props.style.fg, '#ff6b6b');
  await setSlotWidth(full.length + 4);
  assert.equal(text(), full, 'full layout returns once the terminal widens again');
  terminalWidth = 20;
  assert.equal(bar.props.paddingLeft, 1, 'narrow session padding matches the host');
  assert.equal(bar.props.paddingRight, 1);
  await setSlotWidth(20);
  assert.equal(bar.props.children.length, 3, 'narrow layout retains whole account groups');
  assert.equal(slots.length, slotCount, 'resizing does not remount slots');
  terminalWidth = 200;
  await setSlotWidth(200);
  route = { type: 'home' };
  assert.equal(visibility.props.when, true, 'home route displays the bar');
  terminalWidth = 20;
  assert.equal(bar.props.paddingLeft, 2, 'home footer uses two-column padding');
  terminalWidth = 200;
  route = { type: 'session', sessionID: 'test-session' };
  const click = bar.props.onMouseDown;
  click({ button: 2 });
  assert.equal(route.type, 'session');
  click({ button: 0, isDragging: true });
  assert.equal(route.type, 'session');
  click({ button: 0 });
  assert.equal(route.name, 'opencode-usage.limits.dashboard');
  assert.equal(visibility.props.when, false, 'bar is hidden on plugin routes');
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
  assert.ok(!rows.some((row) => row.includes('Source: live usage endpoint')));
  dispose();
  assert.ok(slots.every(({removed}) => removed));
  assert.ok(routeRemoved);
});

test('project spend fetches only on open and manual refresh, never startup or timer', async () => {
  let timer, routeDefinition, globalCommands, dashboardCommands;
  let costCalls = 0;
  let release;
  const context = vm.createContext({
    ...model, compactPercentageParts, percentageParts, Date, Promise,
    loadConfig: () => ({config:validateConfig({openaiProjectCosts:{enabled:true,endpoint:'https://example.org/costs'}})}),
    createCollectors: () => ({fetchGo:async () => ({enabled:false}),fetchClipProxy:async () => ({enabled:false}),fetchProjectCosts:() => {
      costCalls++;
      return new Promise(resolve => { release = resolve; });
    }}),
    jsx:(type,props) => ({type,props}), For:'For', useTerminalDimensions:() => () => ({width:100}),
    createSignal:(initial) => {let value=initial; return [() => value, next => {value=next;}];},
    setInterval:(callback) => {timer=callback; return {unref(){}};}, clearInterval(){},
  });
  const source = readFileSync(new URL('./tui.js', import.meta.url),'utf8')
    .replace(/^import\s+[\s\S]*?;\s*$/gm,'').replace('export default {','globalThis.plugin = {');
  vm.runInContext(source,context);
  const dispose = context.plugin.setup({theme:{text:{base:'white'}}, keymap:{layer:factory => {
    const layer = factory(); if (layer.mode === 'global') globalCommands = layer.commands; else dashboardCommands = layer.commands;
  }}, ui:{slot:() => () => {},router:{current:() => ({type:'home'}),navigate(){},register:definition => {routeDefinition=definition; return () => {};}}}});
  await new Promise(resolve => setImmediate(resolve));
  timer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(costCalls,0);
  globalCommands[0].run();
  assert.equal(costCalls,1);
  assert.equal(routeDefinition.render().props.children[0].props.children, 'Limits — quota and project spend');
  release({ok:false,error:'request failed'});
  await new Promise(resolve => setImmediate(resolve));
  dashboardCommands.find(command => command.bind === 'r').run();
  assert.equal(costCalls,2);
  release({ok:false,error:'request failed'});
  dispose();
});
