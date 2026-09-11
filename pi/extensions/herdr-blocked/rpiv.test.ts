import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedActive, questionnaireLabel } from "./rpiv.ts";

test("the first question's header is what herdr shows", () => {
  const payload = { questions: [{ header: "Predicate", question: "What should count as blocked?" }] };
  assert.equal(questionnaireLabel(payload), "Predicate");
});

// rpiv requires a header, so this is a questionnaire built by hand or by a
// later rpiv that relaxed the field — the question still names the wait.
test("a questionnaire with no header falls back to the question itself", () => {
  const payload = { questions: [{ header: "   ", question: "Overwrite the branch?" }] };
  assert.equal(questionnaireLabel(payload), "Overwrite the branch?");
});

test("a question too long for a pane label is cut to fit", () => {
  const question = "Which approach should the bridge take when the agent asks something long-winded?";
  const label = questionnaireLabel({ questions: [{ header: "", question }] });
  assert.equal(label.length, 60);
  assert.ok(label.endsWith("…"));
  assert.ok(question.startsWith(label.slice(0, -1)));
});

// herdr renders the label on one line beside the pane; a newline would either
// break its layout or be silently eaten, and neither reads as a question.
test("a question spread over several lines arrives as one", () => {
  const payload = { questions: [{ header: "", question: "Run project-local agents?\n\nOnly for trusted repos." }] };
  assert.equal(questionnaireLabel(payload), "Run project-local agents? Only for trusted repos.");
});

test("a questionnaire with no questions still says what pi waits for", () => {
  assert.equal(questionnaireLabel({ questions: [] }), "waiting for an answer");
});

// The bus hands every listener `unknown`. A payload this does not recognise —
// a later rpiv, another emitter on the channel — must still label the pane.
test("a payload of an unexpected shape still says what pi waits for", () => {
  for (const payload of [undefined, null, "blocked", { questions: "none" }, { questions: [{}] }]) {
    assert.equal(questionnaireLabel(payload), "waiting for an answer");
  }
});

test("an active payload means pi is waiting on you", () => {
  assert.equal(blockedActive({ active: true }), true);
});

test("an inactive payload ends the wait", () => {
  assert.equal(blockedActive({ active: false }), false);
});

// A pane stuck on "blocked" is the worse failure, so anything unrecognisable
// clears rather than blocks.
test("an unrecognisable payload ends the wait rather than stranding the pane", () => {
  for (const payload of [undefined, null, {}, { active: "yes" }]) {
    assert.equal(blockedActive(payload), false);
  }
});
