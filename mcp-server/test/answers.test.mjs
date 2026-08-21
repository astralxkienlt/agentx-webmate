/**
 * Answer validation for paused runs.
 *
 * The extension's permission parser accepts exactly 'once' | 'always' | 'deny'
 * and fails closed to deny for anything else. These tests pin the two defences
 * this server adds: status text that spells the tokens out, and refusal to
 * forward an answer that would be misread.
 *
 * Run: node --test test/answers.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import test from "node:test";

const { describePendingInput, describeSnapshot, validateAnswer } = await import("../dist/runs.js");

const PERMISSION = {
  clarifyId: "perm_1",
  permission: { capability: "navigate", host: "youtube.com" },
  question: "AgentX WebMate wants to navigate to youtube.com. Allow it?",
  options: ["once", "always", "deny"],
};

const FREE_TEXT = { clarifyId: "c_1", question: "Which account should I use?" };

const CHOICE = { clarify_id: "c_2", question: "Which report?", options: ["Daily", "Weekly"] };

test("free-text questions accept any non-empty answer verbatim", () => {
  assert.deepEqual(validateAnswer(FREE_TEXT, "  the work account "), { ok: true, answer: "the work account" });
  assert.deepEqual(validateAnswer(null, "anything"), { ok: true, answer: "anything" });
  assert.equal(validateAnswer(FREE_TEXT, "   ").ok, false);
});

test("option questions accept an exact option case-insensitively and normalise it", () => {
  assert.deepEqual(validateAnswer(CHOICE, "weekly"), { ok: true, answer: "Weekly" });
  assert.deepEqual(validateAnswer(PERMISSION, "ALWAYS"), { ok: true, answer: "always" });
  assert.deepEqual(validateAnswer(PERMISSION, " deny "), { ok: true, answer: "deny" });
});

test("natural language is never mapped onto a permission token", () => {
  for (const answer of ["Có", "yes", "ok", "sure", "allow", "đồng ý", "no", "1"]) {
    const verdict = validateAnswer(PERMISSION, answer);
    assert.equal(verdict.ok, false, answer);
    assert.match(verdict.message, /once \| always \| deny/);
    assert.match(verdict.message, /navigate to youtube\.com/);
    assert.match(verdict.message, /was not sent/);
    assert.ok(verdict.message.includes(`"${answer}"`), "the rejected answer is echoed back");
  }
});

test("a choice question that is not a permission explains itself too", () => {
  const verdict = validateAnswer(CHOICE, "monthly");
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /Which report\?/);
  assert.match(verdict.message, /Daily \| Weekly/);
});

test("describePendingInput normalises both clarify id spellings and tolerates junk", () => {
  assert.equal(describePendingInput(CHOICE)?.clarifyId, "c_2");
  assert.equal(describePendingInput(PERMISSION)?.permission?.host, "youtube.com");
  assert.deepEqual(describePendingInput({ clarifyId: "x", options: ["a", 3, ""] })?.options, ["a"]);
  assert.equal(describePendingInput("nope"), null);
  assert.equal(describePendingInput(undefined), null);
});

test("describeSnapshot spells out permission tokens and generic choices", () => {
  const permissionText = describeSnapshot({ runId: "r", status: "needs_user_input", pendingInput: PERMISSION });
  assert.match(permissionText, /PERMISSION REQUEST — AgentX WebMate wants to navigate to youtube\.com\./);
  assert.match(permissionText, /EXACTLY one of: once \| always \| deny/);
  assert.match(permissionText, /remember for youtube\.com/);
  assert.match(permissionText, /Never forward their words verbatim/);
  assert.match(permissionText, /clarify_id: perm_1/);

  const choiceText = describeSnapshot({ runId: "r", status: "needs_user_input", pendingInput: CHOICE });
  assert.match(choiceText, /question: Which report\?/);
  assert.match(choiceText, /accepted answers \(send one of these exactly\): Daily \| Weekly/);
  assert.match(choiceText, /clarify_id: c_2/);

  const freeText = describeSnapshot({ runId: "r", status: "needs_user_input", pendingInput: FREE_TEXT });
  assert.doesNotMatch(freeText, /accepted answers/);
  assert.match(freeText, /Which account should I use\?/);
});

test("unknown capabilities still render a readable permission sentence", () => {
  const text = describeSnapshot({
    runId: "r",
    status: "needs_user_input",
    pendingInput: { clarifyId: "p", permission: { capability: "teleport", host: "example.com" }, options: ["once", "always", "deny"] },
  });
  assert.match(text, /wants to use 'teleport' on example\.com/);
});
