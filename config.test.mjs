import { test } from "node:test";
import assert from "node:assert/strict";
import { configPath, expandHome, loadConfig, readCredential, validateConfig } from "./config.js";

test("configuration defaults, XDG and explicit tilde files", () => {
  const config = validateConfig();
  assert.equal(config.refreshMs, 60000);
  assert.equal(config.timeoutMs, 8000);
  assert.equal(config.opencodeGo.enabled, false);
  assert.equal(config.cliproxyapi.enabled, false);
  assert.equal(config.openaiProjectCosts.enabled, false);
  assert.equal(configPath({}, '/synthetic-home'), '/synthetic-home/.config/opencode-usage/config.json');
  assert.equal(configPath({XDG_CONFIG_HOME:'/synthetic-config'}, '/synthetic-home'), '/synthetic-config/opencode-usage/config.json');
  assert.equal(expandHome('~/key', '/synthetic-home'), '/synthetic-home/key');
  assert.equal(expandHome('~', '/synthetic-home'), '/synthetic-home');
});

test("project costs require an explicit safe full endpoint and secret file", () => {
  for (const endpoint of [undefined, 'http://remote.example/costs', 'https://user:pass@example.org/costs', 'https://example.org/costs?key=x', 'https://example.org/costs#x', 'file:///costs']) {
    assert.throws(() => validateConfig({openaiProjectCosts:{enabled:true, endpoint}}));
  }
  assert.throws(() => validateConfig({openaiProjectCosts:{tokenFile:'relative'}}));
  for (const endpoint of ['http://127.0.0.1:4097/v1/openai/project-costs', 'http://[::1]/costs', 'https://example.org/custom/costs']) {
    assert.equal(validateConfig({openaiProjectCosts:{enabled:true, endpoint}}).openaiProjectCosts.endpoint, endpoint);
  }
});

test("credentials prefer environment, then only an explicit file", () => {
  let reads = 0;
  const deps = { env: {KEY:' env-key '}, home:'/synthetic-home', readFile(path) { reads++; assert.equal(path, '/synthetic-home/key'); return ' file-key\n'; } };
  assert.equal(readCredential('KEY', '~/key', deps), 'env-key');
  assert.equal(reads, 0);
  deps.env.KEY = '  ';
  assert.equal(readCredential('KEY', undefined, deps), undefined);
  assert.equal(reads, 0);
  assert.equal(readCredential('KEY', '~/key', deps), 'file-key');
  assert.equal(reads, 1);
  assert.equal(readCredential('KEY', '/explicit', {env:{}, readFile() {throw new Error('private-token');}}), undefined);
});

test("validated settings and safe URL policy", () => {
  for (const input of [null, [], {refreshMs:0}, {refreshMs:1.2}, {refreshMs:'60000'}, {timeoutMs:300001}, {opencodeGo:{enabled:'true'}}, {cliproxyapi:[]}, {opencodeGo:{apiKeyFile:'relative/key'}}, {cliproxyapi:{managementPasswordFile:42}}]) {
    assert.throws(() => validateConfig(input));
  }
  for (const baseUrl of ['http://remote.example', 'https://user:secret@example.org', 'https://example.org?secret=x', 'https://example.org#fragment', 'file:///key', 'not-a-url']) {
    assert.throws(() => validateConfig({cliproxyapi:{baseUrl}}));
  }
  for (const baseUrl of ['https://example.org', 'http://localhost:4003', 'http://[::1]:4003', 'http://127.0.0.1:4003']) {
    assert.equal(validateConfig({cliproxyapi:{baseUrl}}).cliproxyapi.baseUrl, baseUrl);
  }
  assert.equal(validateConfig({refreshMs:2000, timeoutMs:10}).refreshMs, 2000);
});

test("load config handles missing, unreadable, malformed and invalid files without leaking input", () => {
  const options = {env:{}, home:'/synthetic-home'};
  const missing = loadConfig({...options, readFile() {throw Object.assign(new Error('absent'), {code:'ENOENT'});}});
  assert.equal(missing.error, undefined);
  for (const readFile of [() => '{secret-token', () => JSON.stringify({timeoutMs:'secret-token'}), () => {throw new Error('secret-token');}]) {
    const loaded = loadConfig({...options, readFile});
    assert.equal(loaded.config.opencodeGo.enabled, false);
    assert.ok(loaded.error);
    assert.ok(!JSON.stringify(loaded).includes('secret-token'));
  }
  assert.equal(loadConfig({...options, readFile:() => '{"opencodeGo":{"enabled":true}}'}).config.opencodeGo.enabled, true);
});
