import { test } from "node:test";
import assert from "node:assert/strict";
import { chatgptAccountId, parseUsageResponse, quotaRequest } from "./quota.js";
import { compactLine, dashboardLines } from "./model.js";

const envelope = (rate_limit) => ({ status_code: 200, body: JSON.stringify({ plan_type: 'plus', rate_limit }) });
test('live usage fills both previously unknown accounts with actual duration windows', () => {
  const weeklyOnly = parseUsageResponse(envelope({ primary_window: {used_percent:0,limit_window_seconds:604800,reset_at:1893456000},secondary_window:null }));
  assert.equal(weeklyOnly.windows.length, 1);
  assert.equal(weeklyOnly.windows[0].label, 'W');
  assert.equal(weeklyOnly.windows[0].left, 100);
  const both = parseUsageResponse(envelope({ primary_window:{used_percent:12,limit_window_seconds:18000},secondary_window:{used_percent:22,limit_window_seconds:604800} }));
  assert.deepEqual(both.windows.map(({label,left}) => ({label,left})), [{label:'5h',left:88},{label:'W',left:78}]);
  const cpa = {ok:true,accounts:[{account:'an@example.org', ...both, source:'live'}]};
  assert.ok(compactLine({ok:true},cpa).includes('AN 88:78:-'));
  assert.ok(dashboardLines({ok:true},cpa).join('\n').includes('Source: live usage endpoint'));
});

test('upstream failures are checked even when management outer HTTP succeeds', () => {
  assert.throws(() => parseUsageResponse({status_code:401,body:'{}'}), /usage HTTP 401/);
  assert.throws(() => parseUsageResponse({status_code:200,body:'{}'}), /windows unavailable/);
  assert.throws(() => parseUsageResponse({status_code:200,body:'not json'}));
});

test('monthly duration, missing usage and reset fallback are handled honestly', () => {
  const result = parseUsageResponse(envelope({allowed:false, primary_window:{limit_window_seconds:2592000,reset_after_seconds:60}}),0);
  assert.equal(result.windows[0].label,'M');
  assert.equal(result.windows[0].left,undefined);
  assert.equal(result.windows[0].resetsAt,'1970-01-01T00:01:00.000Z');
  assert.equal(result.usageLimited,true);
  assert.deepEqual(result.usageLimitReasons,['allowed=false']);
});

test('account selection matches UI and token substitution remains server-side', () => {
  const file={auth_index:'abc',id_token:{chatgpt_account_id:'account-id'}};
  const request=quotaRequest(file);
  assert.equal(request.header.Authorization,'Bearer $TOKEN$');
  assert.equal(request.header['Chatgpt-Account-Id'],'account-id');
  assert.equal(request.method,'GET');
  assert.equal(request.authIndex,'abc');
  assert.equal(request.url,'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(chatgptAccountId({metadata:{chatgpt_account_id:'metadata-id'}}),'metadata-id');
  const jwt='header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'jwt-id'}})).toString('base64url')+'.sig';
  assert.equal(chatgptAccountId({id_token:jwt}),'jwt-id');
  assert.throws(() => quotaRequest({}), /missing auth index/);
});

test('captured fallback is explicitly marked rather than presented as live', () => {
  const account={account:'old@example.org',source:'captured',signals:{'X-Codex-Primary-Window-Minutes':'300','X-Codex-Primary-Used-Percent':'50'},quotaError:'usage HTTP 403'};
  const cpa={ok:true,accounts:[account]};
  assert.ok(compactLine({ok:true},cpa).includes('50:-:-~'));
  const text=dashboardLines({ok:true},cpa).join('\n');
  assert.ok(text.includes('captured headers (may be stale)'));
  assert.ok(text.includes('Live quota unavailable: usage HTTP 403'));
});
