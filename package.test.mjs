import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package exposes only the TUI entry, allows public files and has no lifecycle scripts", () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.exports, {'./tui':'./tui.js'});
  assert.deepEqual(Object.keys(pkg.scripts), ['test']);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  for (const file of pkg.files) {
    assert.ok(!file.includes('*') && !file.includes('test') && !file.includes('.env') && file !== 'config.json');
    assert.ok(readFileSync(new URL(file, import.meta.url)).length > 0);
  }
});
