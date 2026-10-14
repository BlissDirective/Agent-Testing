import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CallStore, type CallRecord } from "../src/store.js";

const sid = (n: number) => `CA${String(n).padStart(32, "0")}`;
const call = (n: number, extra: Partial<CallRecord> = {}): CallRecord => ({
  sid: sid(n), direction: "inbound", from: "+15550000", to: "+15551111", status: "completed",
  createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(), ...extra,
});

test("call records survive closing and reopening the database", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "store-")), "sub", "gateway.db");
  const store = new CallStore(file);
  store.saveCall(call(1, { status: "ringing" }));
  store.saveCall(call(1, { status: "completed", answeredAt: "2026-01-01T00:00:05Z", endedAt: "2026-01-01T00:01:05Z", duration: 60 }));
  store.saveRecording({ name: `${sid(1)}-1`, callSid: sid(1), createdAt: "2026-01-01T00:00:10Z" });
  store.saveRecording({ name: `${sid(1)}-1`, callSid: sid(1), createdAt: "2026-01-01T00:00:10Z", durationSeconds: 42 });
  store.close();

  const reopened = new CallStore(file);
  assert.deepEqual(reopened.getCall(sid(1)), {
    ...call(1), answeredAt: "2026-01-01T00:00:05Z", endedAt: "2026-01-01T00:01:05Z", duration: 60,
    parentCallSid: undefined, endedReason: undefined,
  });
  assert.deepEqual(reopened.listRecordings(sid(1)).map((r) => r.durationSeconds), [42]);
  assert.equal(reopened.getCall(sid(99)), undefined);
  reopened.close();
});

test("history lists newest first, filters by status, and pages", () => {
  const store = new CallStore(":memory:");
  for (let n = 1; n <= 5; n++) store.saveCall(call(n, { status: n % 2 ? "completed" : "busy" }));
  assert.deepEqual(store.listCalls().map((c) => c.sid), [5, 4, 3, 2, 1].map(sid));
  assert.deepEqual(store.listCalls({ status: "busy" }).map((c) => c.sid), [sid(4), sid(2)]);
  const page = store.listCalls({ limit: 2 });
  assert.deepEqual(store.listCalls({ limit: 2, before: page.at(-1)!.createdAt }).map((c) => c.sid), [sid(3), sid(2)]);
});

test("unfinished calls from a crashed run are marked failed", () => {
  const store = new CallStore(":memory:");
  store.saveCall(call(1, { status: "in-progress" }));
  store.saveCall(call(2, { status: "ringing" }));
  store.saveCall(call(3, { status: "completed", endedAt: "2026-01-03T00:00:00Z" }));
  assert.deepEqual(store.closeOrphans("gateway-restart").sort(), [sid(1), sid(2)]);
  assert.equal(store.getCall(sid(1))!.status, "failed");
  assert.equal(store.getCall(sid(1))!.endedReason, "gateway-restart");
  assert.equal(store.getCall(sid(3))!.endedReason, undefined, "finished calls untouched");
  assert.deepEqual(store.closeOrphans("gateway-restart"), [], "nothing left the second time");
});

test("retention deletes old records and their recording files, nothing else", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recs-"));
  const store = new CallStore(":memory:");
  const now = new Date("2026-06-01T00:00:00Z");
  store.saveCall(call(1, { createdAt: "2026-01-01T00:00:00Z" })); // 151 days old
  store.saveCall(call(2, { createdAt: "2026-05-15T00:00:00Z" })); // 17 days old
  store.saveCall(call(3, { createdAt: "2026-01-01T00:00:00Z", status: "in-progress" })); // old but live
  for (const n of [1, 2]) {
    store.saveRecording({ name: `${sid(n)}-1`, callSid: sid(n), createdAt: "2026-01-01T00:00:00Z" });
    writeFileSync(path.join(dir, `${sid(n)}-1.wav`), "RIFF");
  }
  const outsider = path.join(dir, "not-a-recording.wav");
  writeFileSync(outsider, "x");

  assert.deepEqual(await store.purge(90, dir, now), { calls: 1, recordings: 1 });
  assert.equal(store.getCall(sid(1)), undefined);
  assert.ok(store.getCall(sid(2)) && store.getCall(sid(3)));
  assert.ok(!existsSync(path.join(dir, `${sid(1)}-1.wav`)), "old recording file deleted");
  assert.ok(existsSync(path.join(dir, `${sid(2)}-1.wav`)), "recent recording kept");
  assert.ok(existsSync(outsider), "unrelated files untouched");
  assert.deepEqual(store.listRecordings(sid(1)), []);
});
