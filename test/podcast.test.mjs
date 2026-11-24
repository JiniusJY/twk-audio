import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeForSpeech,
  stripDeliveryTags,
  stripRedundantResumePrefix,
  trimSilence,
  encodeWav,
  makeNoteFlipSfx,
  parseRetryAfterMs,
  withRetry,
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

test("normalizeForSpeech expands currencies, units, and percentages", () => {
  assert.equal(normalizeForSpeech("raised $4.5M and S$12M"), "raised 4.5 million dollars and 12 million Singapore dollars");
  assert.equal(normalizeForSpeech("US$2.4B at 130kW and 200ms"), "2.4 billion U S dollars at 130 kilowatts and 200 milliseconds");
  assert.equal(normalizeForSpeech("128GB on 3nm at 70%"), "128 gigabytes on 3 nanometre at 70 percent");
});

test("normalizeForSpeech handles plural/possessive acronyms, hyphenated compounds, and URLs", () => {
  assert.equal(normalizeForSpeech("APIs and GPUs on GitHub's cloud"), "A P I's and G P U's on Git Hub's cloud");
  assert.equal(normalizeForSpeech("AI-powered USB-C over IPv6"), "A I-powered U S B-C over I P v 6");
  assert.equal(normalizeForSpeech("visit techwhoknows.com/podcasts"), "visit Tech Who Knows dot com slash podcasts");
  assert.equal(normalizeForSpeech("Kubernetes FP8 INT4 in ASEAN"), "Koo-ber-net-eez F P 8 int 4 in ah-see-an");
  assert.equal(normalizeForSpeech("24/7 R&D — e.g. CI/CD"), "twenty-four seven R and D, for example, C I C D");
});

test("stripRedundantResumePrefix removes repeated back-to-it after subscribe break", () => {
  const turns = [
    { speaker: "A", text: "Right. Back to it.", segment: "subscribe" },
    { speaker: "B", chapter: "03. Next", text: "Right, back to it. So why did the grid stall?", ttsText: "Right, back to it. So why did the grid stall?" },
  ];
  const cleaned = stripRedundantResumePrefix(turns);
  assert.equal(cleaned[1].text, "So why did the grid stall?");
  assert.equal(cleaned[1].ttsText, "So why did the grid stall?");
  assert.equal(cleaned[1].chapter, "03. Next");
});

test("stripRedundantResumePrefix drops empty resume turn and preserves chapter on next turn", () => {
  const turns = [
    { speaker: "A", text: "Right. Back to it.", segment: "subscribe" },
    { speaker: "B", chapter: "03. Next", text: "Right. Back to it." },
    { speaker: "A", text: "Back to Fort Meade, the patch failed." },
  ];
  const cleaned = stripRedundantResumePrefix(turns);
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[1].chapter, "03. Next");
  assert.equal(cleaned[1].text, "Back to Fort Meade, the patch failed.");
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

test("mapWithConcurrency drains active workers and stops new work after failure", async () => {
  let finished = false;
  const started = [];
  await assert.rejects(() => mapWithConcurrency([0, 1, 2, 3], 2, async (n) => {
    started.push(n);
    if (n === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw new Error("test failure");
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
    finished = true;
  }), /test failure/);
  assert.equal(finished, true);
  assert.deepEqual(started, [0, 1]);
});

test("parseRetryAfterMs parses numeric seconds and ignores empty values", () => {
  assert.equal(parseRetryAfterMs("90"), 90_000);
  assert.equal(parseRetryAfterMs("1.5"), 1_500);
  assert.equal(parseRetryAfterMs(""), null);
  assert.equal(parseRetryAfterMs(null), null);
});

test("withRetry honours Retry-After header with a 2s buffer and caps at 120s", async () => {
  const waits = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const err = new Error("Rate limited");
        err.status = 429;
        err.retryAfterMs = calls === 1 ? 45_000 : 150_000;
        throw err;
      }
      return "ok";
    },
    { attempts: 4, baseMs: 2000, sleepFn: async (ms) => { waits.push(ms); } },
  );
  assert.equal(result, "ok");
  assert.deepEqual(waits, [47_000, 120_000]);
});

test("withRetry uses cooldown-aware backoff on 429 or cooling-down messages without Retry-After", async () => {
  const waits = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls <= 3) {
        const err = new Error("No model answered: nim cooling down after rate limiting");
        err.status = 502;
        throw err;
      }
      return "recovered";
    },
    { attempts: 4, baseMs: 4000, sleepFn: async (ms) => { waits.push(ms); } },
  );
  assert.equal(result, "recovered");
  assert.deepEqual(waits, [35_000, 70_000, 95_000]);
});
