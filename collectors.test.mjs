import { test } from "node:test";
import assert from "node:assert/strict";
import { createCollectors, displayText } from "./collectors.js";

test("provider display fields cannot inject terminal escapes, newlines or bidi controls", () => {
  assert.equal(displayText("\u001b[31maccount\u001b[0m\nname\u202e"), "account name");
  assert.equal(displayText("x".repeat(400)).length, 256);
});
import { validateConfig } from "./config.js";
import { compactLine, dashboardLines } from "./model.js";

const json = (body) => ({ ok:true, json:async () => body });
const credentials = {OPENCODE_GO_API_KEY:'synthetic-go-key', CLIPROXY_MANAGEMENT_PASSWORD:'synthetic-cpa-key'};
const enabled = (input = {}) => validateConfig({opencodeGo:{enabled:true}, cliproxyapi:{enabled:true}, ...input});

test("disabled sources have zero secret reads or requests, hide failures and provide setup", async () => {
  const collectors = createCollectors(validateConfig({opencodeGo:{enabled:false, apiKeyFile:'~/never-read-go'},cliproxyapi:{enabled:false,managementPasswordFile:'~/never-read-cpa'}}), {env:credentials, readFile() {assert.fail('secret read');}, fetch() {assert.fail('network');}});
  const go = await collectors.fetchGo();
  const cpa = await collectors.fetchClipProxy();
  assert.equal(compactLine(go,cpa), 'Limits · /limits setup');
  const lines = dashboardLines(go,cpa);
  assert.ok(lines.some(line => line.includes('Both sources are disabled')));
  assert.ok(!lines.some(line => line.includes('Unavailable')));
  assert.ok(!compactLine({ok:true}, cpa).includes('CPA'));
  assert.ok(!compactLine(go, {ok:false}).includes('GO'));
  assert.ok(!dashboardLines(go, {ok:false}).some(line => line.includes('GO  OpenCode')));
  assert.ok(!dashboardLines({ok:false}, cpa).some(line => line.includes('CLIProxyAPI')));
});

test("each source works alone and missing credentials do not fetch", async () => {
  const c = createCollectors(enabled(), {env:{}, fetch() {assert.fail('missing credentials');}});
  assert.equal((await c.fetchGo()).error, 'missing API key');
  assert.equal((await c.fetchClipProxy()).error, 'missing management password');
  const solo = createCollectors(enabled({cliproxyapi:{enabled:false}}), {env:credentials, fetch:async (url, options) => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(options.headers.authorization, 'Bearer synthetic-go-key');
    assert.equal(options.redirect, 'error');
    return json({usage:{rolling:{percent:25,status:'rate-limited',resetsAt:'2030-01-01T00:00:00Z'}}});
  }});
  const go = await solo.fetchGo();
  assert.equal(go.rolling.left, 75);
  assert.equal(go.rolling.limited, true);
  assert.equal(compactLine(go,await solo.fetchClipProxy()), 'GO 75:-:-');
});

test("request failures, HTTP and parser errors are sanitized; sources fail independently", async () => {
  for (const failure of [new Error('synthetic-go-key secret body'), Object.assign(new Error('token'),{name:'TimeoutError'})]) {
    const c = createCollectors(enabled(), {env:credentials, fetch:async () => {throw failure;}});
    for (const result of [await c.fetchGo(), await c.fetchClipProxy()]) {
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes('token'));
      assert.ok(!JSON.stringify(result).includes('synthetic-go-key'));
    }
  }
  const c = createCollectors(enabled(), {env:credentials, fetch:async (url) => url.includes('/credentials') ? json({files:[]}) : {ok:false,status:401}});
  assert.equal((await c.fetchGo()).error, 'HTTP 401');
  assert.deepEqual(await c.fetchClipProxy(), {ok:true,accounts:[]});
  const malformed = createCollectors(enabled(), {env:credentials, fetch:async () => ({ok:true,json() {throw new Error('private body');}})});
  assert.equal((await malformed.fetchGo()).error, 'request failed');
});

test("CPA reads Codex only, uses fixed quota GET placeholder, bounds concurrency and retains captured fallback", async () => {
  let active = 0;
  let max = 0;
  let calls = 0;
  const files = Array.from({length:9}, (_,i) => ({provider:'codex', account:`test${i}@example.org`, auth_index:String(i), quota:{signals:{'X-Codex-Primary-Window-Minutes':300,'X-Codex-Primary-Used-Percent':40}}}));
  files.push({provider:'other',account:'other@example.org'});
  const c = createCollectors(enabled({opencodeGo:{enabled:false}}), {env:credentials, fetch:async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer synthetic-cpa-key');
    if (url.endsWith('/credentials')) { assert.equal(options.method, undefined); return json({files}); }
    assert.equal(url, 'http://127.0.0.1:4003/v8/management/requests/api-call');
    assert.equal(options.method, 'POST');
    const request = JSON.parse(options.body);
    assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(request.method, 'GET');
    assert.equal(request.header.Authorization, 'Bearer $TOKEN$');
    calls++; active++; max = Math.max(max,active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (request.authIndex === '0') throw new Error('synthetic-cpa-key');
    return json({status_code:200,body:{rate_limit:{primary_window:{limit_window_seconds:18000,used_percent:20}}}});
  }});
  const result = await c.fetchClipProxy();
  assert.equal(result.accounts.length, 9);
  assert.equal(calls, 9);
  assert.equal(max, 4);
  assert.equal(result.accounts[0].source, 'captured');
  assert.equal(result.accounts[0].quotaError, 'request failed');
  assert.equal(result.accounts[1].windows[0].left, 80);
  assert.ok(compactLine(await c.fetchGo(), result).includes('60:-:-~'));
  assert.ok(!JSON.stringify(result).includes('synthetic-cpa-key'));
});

test("CPA API-call malformed and failed upstream responses never leak bodies", async () => {
  for (const response of [{status_code:401,body:'private'}, {status_code:200,body:'private'}, {status_code:200,body:{}}]) {
    const c = createCollectors(enabled(), {env:credentials, fetch:async url => url.endsWith('/credentials') ? json({files:[{provider:'codex', auth_index:'test'}]}) : json(response)});
    const result = await c.fetchClipProxy();
    assert.equal(result.ok,true);
    assert.equal(result.accounts[0].quotaError,'request failed');
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});
