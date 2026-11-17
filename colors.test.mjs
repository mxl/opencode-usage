import { test } from "node:test";
import assert from "node:assert/strict";
import { percentageParts } from "./colors.js";

const flatten = (text) => percentageParts(text).map(({ text: part }) => part).join("");

test("each value in compact 5h:W:M triplets uses strict 10/30 thresholds", () => {
  const bar = "GO 9:10:29 · CH.UL 30:-:0! · PP ?:?:?";
  const parts = percentageParts(bar);
  assert.equal(flatten(bar), bar, "formatting must not rewrite text");
  assert.deepEqual(parts.filter(({ text }) => /^\d+$/.test(text)).map(({ text, color }) => [text, color]), [
    ["9", "#ff6b6b"], ["10", "#facc15"], ["29", "#facc15"],
    ["30", undefined], ["0", "#ff6b6b"],
  ]);
});

test("dashboard window labels and percentages stay colored together", () => {
  const dashboard = "  5h:9%    reset 4h · W:30%";
  const parts = percentageParts(dashboard);
  assert.equal(flatten(dashboard), dashboard);
  assert.deepEqual(parts.filter(({ text }) => text.includes(":" )).map(({ text, color }) => [text, color]), [
    ["5h:9%", "#ff6b6b"], ["W:30%", undefined],
  ]);
});

test("clock times and other numbers are never interpreted as quota triplets", () => {
  const clock = "Last fetched 4:15:21 PM · auto-refresh 60s · reset 4h26m";
  const parts = percentageParts(clock);
  assert.deepEqual(parts.map(({ color }) => color).filter(Boolean), []);
  assert.equal(flatten(clock), clock);
});
