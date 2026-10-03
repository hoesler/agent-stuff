import assert from "node:assert/strict";
import { test } from "node:test";
import { type Clock, FRAME_MS, GhosttyTitle, type Terminal } from "./title.ts";

type Timer = { fn: () => void; ms: number; repeat: boolean; live: boolean };

function fakeClock(): Clock & { timers: Timer[]; tick(): void } {
  const timers: Timer[] = [];
  const add = (fn: () => void, ms: number, repeat: boolean) => {
    const t = { fn, ms, repeat, live: true };
    timers.push(t);
    return t;
  };
  const clear = (h: unknown) => {
    if (h) (h as Timer).live = false;
  };
  return {
    timers,
    setInterval: (fn, ms) => add(fn, ms, true),
    clearInterval: clear,
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearTimeout: clear,
    /** Fire every live interval once. */
    tick() {
      for (const t of timers.filter((t) => t.live && t.repeat)) t.fn();
    },
  };
}

function fakeTerminal(): Terminal & { titles: string[]; progress: string[] } {
  const titles: string[] = [];
  const progress: string[] = [];
  return {
    titles,
    progress,
    setTitle: (t) => void titles.push(t),
    setProgress: (state, value) => void progress.push(value === undefined ? `${state}` : `${state};${value}`),
  };
}

function setup() {
  const term = fakeTerminal();
  const clock = fakeClock();
  const title = new GhosttyTitle(term, clock, "agentdash");
  title.sessionStart("claude-sonnet", undefined);
  return { term, clock, title, live: () => clock.timers.filter((t) => t.live && t.repeat).length };
}

test("an idle session shows project and model", () => {
  const { term } = setup();
  assert.deepEqual(term.titles, ["π · agentdash · claude-sonnet"]);
});

test("a session name sits between project and model", () => {
  const term = fakeTerminal();
  new GhosttyTitle(term, fakeClock(), "agentdash").sessionStart("claude-sonnet", "palette");
  assert.deepEqual(term.titles, ["π · agentdash · palette · claude-sonnet"]);
});

test("a working agent animates a spinner with the running tool in place of the model", () => {
  const { term, clock, title } = setup();
  title.agentStart();
  assert.equal(clock.timers.at(-1)?.ms, FRAME_MS);
  clock.tick();
  title.toolStart("bash");
  clock.tick();
  assert.deepEqual(term.titles.slice(1), ["⠋ π · agentdash · claude-sonnet", "⠙ π · agentdash · bash"]);
  assert.deepEqual(term.progress, ["3"]);
});

test("the end of a turn stops the spinner and flashes progress complete", () => {
  const { term, clock, title, live } = setup();
  title.agentStart();
  title.agentEnd();
  assert.equal(live(), 0);
  assert.equal(term.titles.at(-1), "π · agentdash · claude-sonnet");
  clock.timers.filter((t) => t.live && !t.repeat).forEach((t) => t.fn());
  assert.deepEqual(term.progress, ["3", "1;100", "0"]);
});

// The reason this fork exists: while a prompt waits on you, the title holds
// still, so a suffix another tool appends (agentdash's "● needs you") stays.
test("a prompt during a turn freezes the title on the running tool", () => {
  const { term, clock, title, live } = setup();
  title.agentStart();
  title.toolStart("ask_user");
  clock.tick();
  title.promptStart();
  assert.equal(live(), 0);
  assert.equal(term.titles.at(-1), "π · agentdash · ask_user");
  const before = term.titles.length;
  clock.tick();
  assert.equal(term.titles.length, before);
});

test("the spinner resumes where it left off once the prompt is answered", () => {
  const { term, clock, title, live } = setup();
  title.agentStart();
  title.toolStart("ask_user");
  clock.tick();
  title.promptStart();
  title.promptEnd();
  assert.equal(live(), 1);
  clock.tick();
  assert.equal(term.titles.at(-1), "⠙ π · agentdash · ask_user");
});

// Menus you open yourself while idle (/mode, /tools) raise the same events.
test("a prompt while idle leaves the title alone and starts nothing", () => {
  const { term, title, live } = setup();
  title.promptStart();
  title.promptEnd();
  assert.deepEqual(term.titles, ["π · agentdash · claude-sonnet"]);
  assert.equal(live(), 0);
});

test("a turn that ends during a prompt does not restart the spinner afterwards", () => {
  const { title, live } = setup();
  title.agentStart();
  title.promptStart();
  title.agentEnd();
  title.promptEnd();
  assert.equal(live(), 0);
});

test("a model change while idle retitles; while working it waits for the next frame", () => {
  const { term, clock, title } = setup();
  title.modelSelect("gpt-5");
  assert.equal(term.titles.at(-1), "π · agentdash · gpt-5");
  title.agentStart();
  const before = term.titles.length;
  title.modelSelect("claude-opus");
  assert.equal(term.titles.length, before);
  clock.tick();
  assert.equal(term.titles.at(-1), "⠋ π · agentdash · claude-opus");
});

test("shutdown stops every timer and clears the progress bar", () => {
  const { term, clock, title } = setup();
  title.agentStart();
  title.agentEnd();
  title.shutdown();
  assert.equal(clock.timers.filter((t) => t.live).length, 0);
  assert.equal(term.progress.at(-1), "0");
});
