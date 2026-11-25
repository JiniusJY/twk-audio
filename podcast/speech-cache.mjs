import { cacheKey, readCache, writeCache, removeCache } from "./cache.mjs";

export function speechIdentity({ text, voice, speed, model, route = "direct" }) {
  return { schema: 2, provider: "fish", route, model, text, voice, speed,
    format: "mp3", bitrate: route === "proxy" ? 64 : 128, temperature: route === "proxy" ? 0.68 : 0.84, topP: route === "proxy" ? 0.78 : 0.86,
    volume: 0, normalizeLoudness: true, sampleRate: 24000 };
}

// Decode before committing: empty/corrupt service replies must never become hits.
// The returned model is the one used for this request, not shared mutable fallback
// state. A paid-model fallback is stored only under the free model's identity.
export async function cachedSpeech({ root, identity, synthesize, decode, warn = console.warn }) {
  const key = cacheKey(identity);
  const cached = await readCache(root, "speech", key).catch((error) => {
    warn(`Speech cache read skipped: ${error.code || error.message}`);
    return null;
  });
  if (cached) {
    try {
      const samples = await decode(cached);
      validateSamples(samples);
      return { samples, hit: true };
    } catch {
      await removeCache(root, "speech", key).catch(() => {});
      warn("Discarded invalid cached speech; synthesizing again.");
    }
  }
  const { audio, model } = await synthesize();
  const samples = await decode(audio);
  validateSamples(samples);
  const actualKey = cacheKey({ ...identity, model });
  await writeCache(root, "speech", actualKey, audio).catch((error) => {
    warn(`Speech cache write skipped: ${error.code || error.message}`);
  });
  return { samples, hit: false };
}

function validateSamples(samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0 || !samples.every(Number.isFinite)) {
    throw new Error("Fish returned empty or invalid audio samples");
  }
}
