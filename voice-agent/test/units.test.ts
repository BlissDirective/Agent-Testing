import assert from "node:assert/strict";
import { test } from "node:test";
import { SentenceChunker } from "../src/chunker.js";
import { defaultConfig } from "../src/config.js";
import { parseClientMessage } from "../src/protocol.js";
import { endpointDelaySeconds, shouldInterrupt } from "../src/turn-taking.js";

test("chunker emits whole sentences as they complete", () => {
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push("Hello there. How"), ["Hello there."]);
  assert.deepEqual(chunker.push(" are you? I'm"), ["How are you?"]);
  assert.deepEqual(chunker.flush(), ["I'm"]);
});

test("chunker honours <flush/> and splits long clauses", () => {
  const chunker = new SentenceChunker(20, 40);
  assert.deepEqual(chunker.push("One moment<flush/>please"), ["One moment"]);
  assert.deepEqual(chunker.push(" wait, while I look that up for you"), ["please wait,"]);
  assert.deepEqual(chunker.flush(), ["while I look that up for you"]);
});

test("endpoint delay depends on how the transcript ends", () => {
  const plan = defaultConfig.startSpeakingPlan;
  assert.equal(endpointDelaySeconds("What time is it?", plan), plan.onPunctuationSeconds);
  assert.equal(endpointDelaySeconds("my number is 555", plan), plan.onNumberSeconds);
  assert.equal(endpointDelaySeconds("I was thinking", plan), plan.onNoPunctuationSeconds);
});

test("interruption rules: acknowledgements, phrases and word count", () => {
  const plan = defaultConfig.stopSpeakingPlan; // numWords: 2
  assert.equal(shouldInterrupt("Yeah.", plan), false);
  assert.equal(shouldInterrupt("mm-hmm", plan), false);
  assert.equal(shouldInterrupt("so", plan), false);
  assert.equal(shouldInterrupt("Wait!", plan), true);
  assert.equal(shouldInterrupt("actually I", plan), true);
  assert.equal(shouldInterrupt("", { ...plan, numWords: 0 }), true);
});

test("client messages are validated", () => {
  assert.deepEqual(parseClientMessage('{"type":"say","message":"hi"}'), { type: "say", message: "hi" });
  assert.equal(parseClientMessage('{"type":"say"}'), null);
  assert.equal(parseClientMessage("not json"), null);
  assert.deepEqual(parseClientMessage('{"type":"add-message","role":"user","content":"x"}'), {
    type: "add-message",
    role: "user",
    content: "x",
    triggerResponse: false,
  });
});
