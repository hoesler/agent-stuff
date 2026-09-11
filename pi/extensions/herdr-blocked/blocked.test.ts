import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { clearBlocked, HERDR_BLOCKED_EVENT, reportBlocked, whileBlocked } from "./blocked.ts";

function fakeBus(): EventBus & { sent: { channel: string; data: unknown }[] } {
  const sent: { channel: string; data: unknown }[] = [];
  return {
    sent,
    emit: (channel, data) => void sent.push({ channel, data }),
    on: () => () => {},
  };
}

test("reporting a block puts the label on herdr's channel", () => {
  const bus = fakeBus();
  reportBlocked(bus, "Predicate");
  assert.deepEqual(bus.sent, [{ channel: HERDR_BLOCKED_EVENT, data: { active: true, label: "Predicate" } }]);
});

// herdr drops the message it is holding once its count reaches zero, so the
// end of a block carries no label of its own.
test("clearing a block sends no label", () => {
  const bus = fakeBus();
  clearBlocked(bus);
  assert.deepEqual(bus.sent, [{ channel: HERDR_BLOCKED_EVENT, data: { active: false } }]);
});

test("a wrapped prompt blocks while it runs and clears when it answers", async () => {
  const bus = fakeBus();
  const answer = await whileBlocked(bus, "Run project-local agents?", async () => {
    assert.deepEqual(bus.sent.map((s) => s.data), [{ active: true, label: "Run project-local agents?" }]);
    return true;
  });
  assert.equal(answer, true);
  assert.deepEqual(bus.sent.map((s) => s.data), [
    { active: true, label: "Run project-local agents?" },
    { active: false },
  ]);
});

// The whole reason the wrapper exists: herdr counts the pairs, so a prompt that
// throws must still close its span or the pane never leaves "blocked".
test("a wrapped prompt that throws still clears, and the error still lands", async () => {
  const bus = fakeBus();
  const boom = new Error("overlay failed to render");
  await assert.rejects(
    whileBlocked(bus, "Predicate", async () => {
      throw boom;
    }),
    boom,
  );
  assert.deepEqual(bus.sent.map((s) => s.data), [{ active: true, label: "Predicate" }, { active: false }]);
});

// Tools are built without a bus in tests, and pi hands one only to extensions.
test("a prompt wrapped without a bus runs anyway, reporting nothing", async () => {
  assert.equal(await whileBlocked(undefined, "Predicate", async () => "answered"), "answered");
});
