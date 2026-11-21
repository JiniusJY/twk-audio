import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeForSpeech,
  stripDeliveryTags,
  trimSilence,
  encodeWav,
  makeNoteFlipSfx,
  mapWithConcurrency,
} from "../podcast/generate-podcast.mjs";

test("normalizeForSpeech splits fused ALLCAPS compounds", () => {
  assert.equal(normalizeForSpeech("NSANet is down"), "N S A Net is down");
  assert.equal(normalizeForSpeech("FastAPI ships fast"), "Fast A P I ships fast");
});

test("normalizeForSpeech expands CVEs and versions", () => {
  assert.equal(normalizeForSpeech("CVE-2026-1234 dropped"), "C V E 2026, 1234 dropped");
  assert.equal(normalizeForSpeech("running v2.1.3 now"), "running version 2 point 1 point 3 now");
});

test("normalizeForSpeech spells known acronyms and maps tricky words", () => {
  assert.equal(normalizeForSpeech("The NSA uses SQL"), "The N S A uses sequel");
  assert.equal(normalizeForSpeech("push to GitHub"), "push to Git Hub");
});

test("normalizeForSpeech keeps Fish delivery tags and drops sfx markers", () => {
  assert.equal(normalizeForSpeech("[chuckles] well then"), "[chuckles] well then");
  assert.equal(normalizeForSpeech("look [sfx:notes] here"), "look here");
});

test("stripDeliveryTags removes bracketed tags", () => {
  assert.equal(stripDeliveryTags("Hello [sighs] there [pauses] friend"), "Hello there friend");
});

test("trimSilence handles an all-silence clip without breaking", () => {
  const quiet = new Float32Array(4800);
  const trimmed = trimSilence(quiet);
  assert.ok(trimmed.length >= 0);
  assert.ok(trimmed.length <= quiet.length);
});

test("encodeWav produces a playable header", () => {
  const wav = encodeWav([new Float32Array(24000)]);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(40), 48000);
});

test("makeNoteFlipSfx is a finite, quiet, sub-second stereo-mono clip", () => {
  const sfx = makeNoteFlipSfx();
  assert.ok(sfx.length > 0 && sfx.length < 24000);
  for (const s of sfx) {
    assert.ok(Number.isFinite(s));
    assert.ok(Math.abs(s) < 0.2);
  }
});

test("mapWithConcurrency preserves order under varied latency", async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results = await mapWithConcurrency(items, 4, async (n) => {
    await new Promise((resolve) => setTimeout(resolve, (n * 7) % 5));
    return n * 2;
  });
  assert.deepEqual(results, items.map((n) => n * 2));
});

test("mapWithConcurrency never exceeds the in-flight limit", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 15 }, (_, i) => i);
  await mapWithConcurrency(items, 3, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak}`);
  assert.ok(peak >= 2, `expected actual parallelism, got peak ${peak}`);
});
