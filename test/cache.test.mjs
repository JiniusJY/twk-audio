import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cacheKey, readCache, writeCache, pruneCache } from "../podcast/cache.mjs";
import { cachedSpeech, speechIdentity } from "../podcast/speech-cache.mjs";

async function temporary(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "twk-cache-test-"));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const config = { text: "Test speech", voice: "voice-a", speed: 1.06, model: "free" };
const decode = async (audio) => {
  if (audio.toString() !== "valid") throw new Error("Invalid MP3");
  return new Float32Array([0.1, -0.2, 0.3]);
};

test("cache storage is atomic, misses are null, and unsafe paths are refused", () => temporary(async (root) => {
  const key = cacheKey({ input: "one" });
  assert.equal(await readCache(root, "speech", key), null);
  await Promise.all(Array.from({ length: 8 }, () => writeCache(root, "speech", key, "valid")));
  assert.equal((await readCache(root, "speech", key)).toString(), "valid");
  assert.deepEqual(await readdir(path.join(root, "speech")), [key]);
  await assert.rejects(() => readCache(root, "../escape", key), /Invalid/);
}));

test("an unchanged speech segment reuses audio with identical decoded samples", () => temporary(async (root) => {
  let calls = 0;
  const options = { root, identity: speechIdentity(config), decode,
    synthesize: async () => { calls++; return { audio: Buffer.from("valid"), model: config.model }; } };
  const cold = await cachedSpeech(options);
  const warm = await cachedSpeech(options);
  assert.equal(calls, 1);
  assert.equal(cold.hit, false);
  assert.equal(warm.hit, true);
  assert.deepEqual(warm.samples, cold.samples);
}));

test("text, voice, speed, model and synthesis settings invalidate cache", () => {
  const identity = speechIdentity(config);
  const key = cacheKey(identity);
  for (const [field, value] of Object.entries({ text: "New text", voice: "other", speed: 0.95,
    model: "paid", temperature: 0.8, topP: 0.9, bitrate: 96, schema: 2, sampleRate: 48000 })) {
    assert.notEqual(cacheKey({ ...identity, [field]: value }), key, field);
  }
});

test("a model fallback is cached under the actual model, never the requested one", () => temporary(async (root) => {
  let calls = 0;
  const options = { root, identity: speechIdentity({ ...config, model: "paid" }), decode,
    synthesize: async () => { calls++; return { audio: Buffer.from("valid"), model: "free" }; } };
  await cachedSpeech(options);
  assert.equal(await readCache(root, "speech", cacheKey(options.identity)), null);
  const warm = await cachedSpeech({ ...options, identity: speechIdentity(config) });
  assert.equal(warm.hit, true);
  assert.equal(calls, 1);
}));

test("corrupt cache is replaced; failed synthesis never creates a cache entry", () => temporary(async (root) => {
  const identity = speechIdentity(config);
  const key = cacheKey(identity);
  await writeCache(root, "speech", key, "corrupt");
  const value = await cachedSpeech({ root, identity, decode, warn: () => {},
    synthesize: async () => ({ audio: Buffer.from("valid"), model: "free" }) });
  assert.equal(value.hit, false);
  assert.equal((await readCache(root, "speech", key)).toString(), "valid");
  const badIdentity = speechIdentity({ ...config, text: "Another" });
  await assert.rejects(() => cachedSpeech({ root, identity: badIdentity, decode,
    synthesize: async () => ({ audio: Buffer.from("bad"), model: "free" }) }), /Invalid MP3/);
  assert.equal(await readCache(root, "speech", cacheKey(badIdentity)), null);
}));

test("empty audio is never saved", () => temporary(async (root) => {
  await assert.rejects(() => cachedSpeech({ root, identity: speechIdentity(config),
    decode: async () => new Float32Array(),
    synthesize: async () => ({ audio: Buffer.from("valid"), model: "free" }) }), /empty/);
  assert.equal(await readCache(root, "speech", cacheKey(speechIdentity(config))), null);
}));

test("a failed render can reuse successfully completed speech after restart", () => temporary(async (root) => {
  let calls = 0;
  const options = { root, identity: speechIdentity(config), decode,
    synthesize: async () => { calls++; return { audio: Buffer.from("valid"), model: "free" }; } };
  await cachedSpeech(options);
  // No in-memory singleton is involved. A new call reads the durable file.
  assert.equal((await cachedSpeech({ ...options })).hit, true);
  assert.equal(calls, 1);
}));

test("pruning bounds cache bytes without affecting output directories", () => temporary(async (root) => {
  for (let i = 0; i < 4; i++) await writeCache(root, "speech", cacheKey(i), "1234567890");
  assert.ok(await pruneCache(root, 20) <= 20);
  assert.ok((await readdir(path.join(root, "speech"))).length <= 2);
}));
