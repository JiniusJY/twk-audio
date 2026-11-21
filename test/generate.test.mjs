import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkSpeech, trimSilence, encodeWav, withRetry } from "../generate.mjs";

test("chunkSpeech keeps paragraphs apart and content intact", () => {
  const text = "First paragraph here. Another sentence follows.\n\nSecond paragraph starts now.";
  const paragraphs = chunkSpeech(text);
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].join(" "), "First paragraph here. Another sentence follows.");
  assert.equal(paragraphs[1].join(" "), "Second paragraph starts now.");
});

test("chunkSpeech never emits a chunk over the max length", () => {
  const sentence = `A run-on thought ${"with many words ".repeat(60)}that never ends.`;
  const paragraphs = chunkSpeech(sentence);
  const chunks = paragraphs.flat();
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 280, `chunk too long: ${chunk.length}`);
  // No words are lost when the chunks are stitched back together.
  const originalWords = sentence.split(/\s+/).filter(Boolean).length;
  const chunkWords = chunks.join(" ").split(/\s+/).filter(Boolean).length;
  assert.equal(chunkWords, originalWords);
});

test("chunkSpeech splits packed sentences into model-sized chunks", () => {
  const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const chunks = chunkSpeech(sentences).flat();
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 280);
});

test("trimSilence strips padded silence and keeps the signal", () => {
  const signal = new Float32Array(24000);
  signal.fill(0.5, 3000, 6000); // loud section from 0.125s to 0.25s
  const trimmed = trimSilence(signal);
  assert.ok(trimmed.length < signal.length);
  assert.ok(trimmed.length >= 3000); // signal survives (plus edge padding)
  let peak = 0;
  for (const s of trimmed) peak = Math.max(peak, Math.abs(s));
  assert.equal(peak, 0.5);
});

test("encodeWav writes a valid 16-bit mono PCM header", () => {
  const { wav, seconds } = encodeWav([new Float32Array([0, 0.5, -0.5, 1, -1])]);
  assert.equal(seconds, 5 / 24000);
  assert.equal(wav.length, 44 + 5 * 2);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24000); // sample rate
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(40), 10); // data bytes
  assert.equal(wav.readInt16LE(44 + 2), Math.round(0.5 * 0x7fff));
  assert.equal(wav.readInt16LE(44 + 8), -0x8000); // -1 clips to full-scale negative
});

test("withRetry retries transient errors and stops on success", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const err = new Error("boom");
        err.status = 503;
        throw err;
      }
      return "ok";
    },
    { attempts: 3, baseMs: 1 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry fails fast on permanent 4xx errors", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const err = new Error("nope");
        err.status = 400;
        throw err;
      },
      { attempts: 3, baseMs: 1 },
    ),
  );
  assert.equal(calls, 1);
});

test("withRetry honors retryIf for domain-specific transient errors", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const err = new Error("The writer did not return a valid chapter");
        err.status = 200;
        throw err;
      },
      { attempts: 2, baseMs: 1, retryIf: (e) => /did not return a valid/.test(e.message) },
    ),
  );
  assert.equal(calls, 2);
});
