#!/usr/bin/env node
/**
 * Generates multi-speaker Who Knows (the TechWhoKnows podcast) episodes with exact millisecond
 * transcript timestamps, chapter markers, and a Podcast RSS 2.0 feed.
 *
 * Supports two TTS providers:
 *   - fish   : Fish Audio API (default: s2.1-pro-free; set FISH_AUDIO_MODEL=s2.1-pro later)
 *   - kokoro : Optional local comparison mode (Apache 2.0); production uses Fish Audio
 *
 * Usage:
 *   node podcast/generate-podcast.mjs --episode ep-01-asean-compute-race
 *   node podcast/generate-podcast.mjs --episode ep-01-asean-compute-race --provider kokoro
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cacheKey, readCache, writeCache, pruneCache } from "./cache.mjs";
import { cachedSpeech, speechIdentity } from "./speech-cache.mjs";
import { publishPodcastFiles } from "./publish.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const CACHE_DIR = process.env.TWK_PODCAST_CACHE_DIR || path.join(repoRoot, ".cache", "podcast");

const { values: args } = parseArgs({
  allowNegative: true,
  options: {
    episode: { type: "string" },
    auto: { type: "boolean", default: false },
    story: { type: "string" },
    writer: { type: "string" },
    source: { type: "string", multiple: true },
    minutes: { type: "string", default: "30" },
    "draft-only": { type: "boolean", default: false },
    provider: { type: "string", default: process.env.TTS_PROVIDER || "fish" },
    "fish-model": { type: "string", default: process.env.FISH_AUDIO_MODEL || "s2.1-pro-free" },
    publish: { type: "boolean", default: Boolean(process.env.TWK_AUTOMATION_URL && process.env.AUTOMATION_INGEST_SECRET) },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});


const SAMPLE_RATE = 24000;
const TURN_GAP_S = 0.18;
const CHAPTER_GAP_S = 0.55;
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const FREE_FISH_MODEL = "s2.1-pro-free";
// Synthesis requests run this many at a time. Fish latency dominates a render, so overlapping
// turns cuts wall-clock time roughly by this factor while assembly stays in script order.
const SYNTH_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.TWK_SYNTH_CONCURRENCY || 3)));
// The active Fish model can drop to the free tier mid-run if the plan rejects the paid one.
let activeFishModel = args["fish-model"];
let fishFallbackLogged = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries transient failures (network errors, timeouts, 429 and 5xx) with backoff. 4xx fails fast. */
async function withRetry(fn, { attempts = 3, baseMs = 2000, label = "request", retryIf = null } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const retryable = (!error.status || error.status === 429 || error.status >= 500) || (retryIf && retryIf(error));
      if (!retryable || attempt === attempts) throw error;
      const wait = baseMs * 2 ** (attempt - 1);
      log(`${label} failed (${String(error.message).slice(0, 200)}); retrying in ${(wait / 1000).toFixed(0)}s (${attempt}/${attempts - 1})`);
      await sleep(wait);
    }
  }
  throw last;
}

/** Maps items through worker with at most `limit` in flight, preserving input order in the results. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let stopped = false;
  async function run() {
    while (!stopped && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }
  const lanes = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) lanes.push(run());
  // Let in-flight work finish before callers clean up scratch files or save a
  // checkpoint. Otherwise one rejected lane races still-running decoders.
  const settled = await Promise.allSettled(lanes);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}

// Who Knows audio kit (owner rule, 19 November 2026): every episode opens on the show's tune, plays a
// short sting before the mid-roll subscribe ask, and closes on the outro. The clips are the instrumental
// opening of the "How did they get away with this" series song, cut by Reel Studio
// projects/podcast/who-knows/kit/make-kit.sh. The first host line comes in at INTRO_LEAD_S, over the
// intro as it ducks and fades. The subscribe turns (segment: "subscribe") are written by the site
// (lib/podcast-writing.ts subscribeBreakTurns), so a script without them is refused.
const SHOW_NAME = "Who Knows";
const KIT_DIR = path.join(here, "kit");
const INTRO_LEAD_S = 6;
const MIDROLL_BEFORE_S = 0.35;
const MIDROLL_AFTER_S = 0.25;
const OUTRO_GAP_S = 0.5;

const DEFAULT_VOICES = {
  A: {
    name: "Jade Chen",
    role: "Lead Tech Editor",
    fishId: process.env.FISH_VOICE_A || "b545c585f631496c914815291da4e893",
    fishSpeed: Number(process.env.FISH_SPEED_A || 1.06),
    kokoroId: process.env.KOKORO_VOICE_A || "bf_emma",
  },
  B: {
    name: "Alok Nair",
    role: "Systems & Infrastructure Analyst",
    fishId: process.env.FISH_VOICE_B || "b9566ee13b074cc9afe09caf9fd47ec7",
    fishSpeed: Number(process.env.FISH_SPEED_B || 1.04),
    kokoroId: process.env.KOKORO_VOICE_B || "bm_george",
  },
};

function log(...parts) {
  console.log(`[twk-podcast]`, ...parts);
}

async function resolveFfmpeg() {
  const mod = await import("ffmpeg-static");
  return mod.default;
}

function runFfmpeg(ffmpegPath, ffmpegArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Decode any audio buffer (e.g., Fish MP3) to mono 24kHz Float32Array via ffmpeg. */
async function decodeAudioToFloat32(ffmpegPath, tmpDir, index, audioBuffer, ext = "mp3") {
  const inFile = path.join(tmpDir, `turn-${index}.${ext}`);
  const outFile = path.join(tmpDir, `turn-${index}.f32`);
  await writeFile(inFile, audioBuffer);
  await runFfmpeg(ffmpegPath, [
    "-y",
    "-i",
    inFile,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-f",
    "f32le",
    outFile,
  ]);
  const raw = await readFile(outFile);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function trimSilence(samples, threshold = 0.008) {
  let start = 0;
  let end = samples.length - 1;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end]) < threshold) end--;
  const pad = Math.round(SAMPLE_RATE * 0.025);
  return samples.subarray(Math.max(0, start - pad), Math.min(samples.length, end + pad + 1));
}

function silence(seconds) {
  return new Float32Array(Math.round(SAMPLE_RATE * seconds));
}

/** Synthesises a subtle, realistic two-flick paper/note-flip sound effect at 24kHz. */
function makeNoteFlipSfx() {
  const durationS = 0.34;
  const len = Math.round(SAMPLE_RATE * durationS);
  const out = new Float32Array(len);
  let hpPrev = 0;
  let lpPrev = 0;
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    // Two soft paper-rustle envelopes: initial lift (~0.02-0.12s) and page settle (~0.17-0.30s)
    const env1 = t >= 0.01 && t <= 0.13 ? Math.sin(((t - 0.01) / 0.12) * Math.PI) * 0.7 : 0;
    const env2 = t >= 0.16 && t <= 0.32 ? Math.sin(((t - 0.16) / 0.16) * Math.PI) : 0;
    const white = rand();
    // Band-pass shape (~1.2kHz-4.5kHz) for crisp paper texture without harsh hiss
    lpPrev = lpPrev * 0.68 + white * 0.32;
    const hp = lpPrev - hpPrev * 0.85;
    hpPrev = lpPrev;
    out[i] = hp * (env1 + env2) * 0.09;
  }
  return out;
}

function encodeWav(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const buffer = Buffer.alloc(44 + total * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + total * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(total * 2, 40);
  let offset = 44;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const s = Math.max(-1, Math.min(1, part[i]));
      buffer.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), offset);
      offset += 2;
    }
  }
  return buffer;
}

/** Strip Fish Audio delivery tags like [chuckles], [sighs], [pauses] when falling back to Kokoro. */
function stripDeliveryTags(text) {
  return text.replace(/\[[^\]]{1,32}\]\s*/g, "").replace(/\s+/g, " ").trim();
}

const PRONUNCIATION_MAP = new Map([
  ["pypi", "Pie P I"],
  ["apac", "A-Pac"],
  ["sqlite", "sequel-lite"],
  ["sql", "sequel"],
  ["postgresql", "Post-gres Q L"],
  ["mysql", "My sequel"],
  ["kubectl", "kube control"],
  ["nginx", "engine X"],
  ["oauth", "oh-auth"],
  ["wi-fi", "why-fie"],
  ["wifi", "why-fie"],
  ["ios", "I O S"],
  ["macos", "Mac O S"],
  ["github", "Git Hub"],
  ["gitlab", "Git Lab"],
  ["nvme", "N V M e"],
  ["saas", "sass"],
  ["paas", "pass"],
  ["iaas", "I-as"],
  ["ciso", "see-so"],
  ["latex", "lay-tech"],
  ["gui", "gooey"],
  ["json", "jayson"],
  ["yaml", "yammel"],
  ["regex", "redge-ex"],
  ["devops", "dev-ops"],
  ["finops", "fin-ops"],
  ["openai", "Open A I"],
  ["chatgpt", "Chat G P T"],
  ["deepseek", "Deep Seek"],
  ["graphql", "Graph Q L"],
]);

const SPELLED_ACRONYMS = new Set([
  "NSA", "PHP", "API", "SDK", "CLI", "SSH", "TLS", "SSL", "DNS", "HTTP", "HTTPS",
  "URL", "URI", "HTML", "CSS", "XML", "CSV", "PDF", "SQL", "FBI", "CIA", "SEC",
  "MAS", "IMDA", "CSA", "AI", "ML", "LLM", "RAG", "MCP", "AWS", "GCP", "VPC",
  "IAM", "MFA", "SSO", "VPN", "CVE", "RCE", "XSS", "CSRF", "CDN", "ISP", "B2B",
  "B2C", "IPO", "VC", "ARR", "MRR", "ROI", "KPI", "CEO", "CTO", "CFO", "COO",
  "GPU", "CPU", "TPU", "NPU", "USB", "RAM", "SSD", "HDD", "OS", "VM", "KVM",
  "TCP", "UDP", "IP", "BGP", "ASN", "SOC", "SIEM", "EDR", "XDR",
]);

function spaceAcronym(word) {
  return word.split("").join(" ");
}

/**
 * Normalises technical acronyms, fused ALLCAPS+Word compounds (e.g. NSANet -> N S A Net),
 * versions, and CVEs for natural TTS pronunciation while preserving [Fish tags].
 */
function normalizeForSpeech(rawText) {
  const parts = String(rawText || "").split(/(\[[^\]]{1,32}\])/g);
  return parts
    .map((part) => {
      if (/^\[sfx:[^\]]+\]$/i.test(part)) return "";
      if (part.startsWith("[") && part.endsWith("]")) return part;
      let out = part;
      // CVE-2026-1234 -> C V E 2026, 1234
      out = out.replace(/\bCVE-(\d{4})-(\d+)\b/gi, (_, y, n) => `C V E ${y}, ${n}`);
      // Version numbers like v2.1 or v2.1.3 -> version 2 point 1
      out = out.replace(/\bv(\d+(?:\.\d+)+)\b/gi, (_, v) => `version ${v.replace(/\./g, " point ")}`);
      // Known tricky tech words (case-insensitive whole word)
      out = out.replace(/\b[A-Za-z][A-Za-z0-9-]*\b/g, (token) => {
        const mapped = PRONUNCIATION_MAP.get(token.toLowerCase());
        if (mapped) return mapped;
        // Fused ALLCAPS + TitleCase word: NSANet -> N S A Net, AWSLambda -> A W S Lambda
        if (/^[A-Z]{2,}[A-Z][a-z]{2,}$/.test(token)) {
          const split = token.replace(/^([A-Z]{2,})([A-Z][a-z]{2,})$/, (_, acr, rest) => `${spaceAcronym(acr)} ${rest}`);
          return split;
        }
        // Fused Word + ALLCAPS suffix: FastAPI -> Fast A P I
        if (/^[A-Z][a-z]{2,}[A-Z]{2,}$/.test(token)) {
          return token.replace(/^([A-Z][a-z]{2,})([A-Z]{2,})$/, (_, head, acr) => `${head} ${spaceAcronym(acr)}`);
        }
        if (SPELLED_ACRONYMS.has(token)) {
          return spaceAcronym(token);
        }
        return token;
      });
      return out;
    })
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function synthFish(text, referenceId, speed = 1.05) {
  const requestedModel = activeFishModel;
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (apiKey) {
    const res = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        model: requestedModel,
      },
      body: JSON.stringify({
        text,
        reference_id: referenceId,
        format: "mp3",
        mp3_bitrate: 128,
        temperature: 0.84,
        top_p: 0.86,
        prosody: {
          speed,
          volume: 0,
          normalize_loudness: true,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Fish Audio ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      err.fallbackable = res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429;
      throw err;
    }
    return { audio: Buffer.from(await res.arrayBuffer()), model: requestedModel };
  }

  // Relay through Vercel (TWK) where FISH_AUDIO_API_KEY is stored.
  const baseUrl = (process.env.TWK_AUTOMATION_URL || "").replace(/\/$/, "");
  const secret = process.env.AUTOMATION_INGEST_SECRET || "";
  if (!baseUrl || !secret) {
    const err = new Error("Neither FISH_AUDIO_API_KEY nor TWK_AUTOMATION_URL/AUTOMATION_INGEST_SECRET is set");
    err.fallbackable = true;
    throw err;
  }
  const res = await fetch(`${baseUrl}/api/automation/podcast`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "tts",
      text,
      referenceId,
      model: requestedModel,
      temperature: 0.84,
      topP: 0.86,
      speed,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`TWK TTS proxy ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    err.fallbackable = [401, 402, 403, 429, 503].includes(res.status);
    throw err;
  }
  return { audio: Buffer.from(await res.arrayBuffer()), model: requestedModel };
}

let kokoroInstance = null;
async function synthFishWithRetry(...input) {
  const initiallyRequestedModel = activeFishModel;
  try {
    return await withRetry(() => synthFish(...input), { attempts: 4, baseMs: 2000, label: "Fish TTS" });
  } catch (error) {
    // The plan can't use the paid model (402/401/403): drop to the free tier for the rest of the run.
    const authFailure = error.status === 401 || error.status === 402 || error.status === 403;
    if (authFailure && initiallyRequestedModel !== FREE_FISH_MODEL) {
      if (!fishFallbackLogged) {
        log(`Fish model ${activeFishModel} unavailable (${error.status}); falling back to ${FREE_FISH_MODEL} for this run.`);
        fishFallbackLogged = true;
      }
      activeFishModel = FREE_FISH_MODEL;
      return withRetry(() => synthFish(...input), { attempts: 4, baseMs: 2000, label: "Fish TTS (free)" });
    }
    throw error;
  }
}

async function getKokoro() {
  if (kokoroInstance) return kokoroInstance;
  const { KokoroTTS } = await import("kokoro-js");
  if (process.env.KOKORO_CACHE_DIR) {
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = process.env.KOKORO_CACHE_DIR;
  }
  log(`Loading Kokoro model (${KOKORO_MODEL_ID})...`);
  kokoroInstance = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: "fp32" });
  return kokoroInstance;
}

async function synthKokoro(text, voiceId) {
  const tts = await getKokoro();
  const clean = stripDeliveryTags(text);
  const audio = await tts.generate(clean, { voice: voiceId, speed: 1.0 });
  return audio.audio;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function rebuildRssFeed(episodesRoot) {
  const entries = await readdir(episodesRoot, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(episodesRoot, entry.name, "manifest.json");
    try {
      const raw = await readFile(manifestPath, "utf8");
      manifests.push(JSON.parse(raw));
    } catch {
      // Skip episodes without a built manifest yet.
    }
  }
  manifests.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const itemsXml = manifests
    .map((m) => {
      const link = m.webUrl || `https://techwhoknows.com/podcasts/${m.slug}`;
      const audioUrl = m.audioUrl || `https://techwhoknows.com/podcasts/${m.slug}/episode.mp3`;
      return `    <item>
      <title>${escapeXml(m.title)}</title>
      <description>${escapeXml(m.description)}</description>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">twk-podcast-${escapeXml(m.slug)}</guid>
      <pubDate>${new Date(m.publishedAt).toUTCString()}</pubDate>
      <enclosure url="${escapeXml(audioUrl)}" length="${m.bytes || 0}" type="audio/mpeg" />
      <itunes:duration>${Math.round(m.durationSeconds || 0)}</itunes:duration>
      <itunes:episode>${m.episodeNumber || 1}</itunes:episode>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
    })
    .join("\n");

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SHOW_NAME}</title>
    <link>https://techwhoknows.com/podcasts</link>
    <description>In-depth AI-hosted technical briefings on AI infrastructure, startups, cybersecurity, and Asia-Pacific technology from TechWhoKnows.</description>
    <language>en-sg</language>
    <itunes:author>TechWhoKnows (TWK)</itunes:author>
    <itunes:category text="Technology" />
    <itunes:explicit>false</itunes:explicit>
    <atom:link href="https://techwhoknows.com/podcasts/feed.xml" rel="self" type="application/rss+xml" />
${itemsXml}
  </channel>
</rss>
`;
  await writeFile(path.join(episodesRoot, "feed.xml"), rss, "utf8");
  log(`Updated RSS feed (${manifests.length} episode(s)) -> ${path.relative(repoRoot, path.join(episodesRoot, "feed.xml"))}`);
}

async function fetchDraftOnce(baseUrl, secret, slugPath, body) {
  const headers = { Authorization: `Bearer ${secret}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}/api/automation/podcast${slugPath}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(310_000),
  });
  const result = await res.json().catch(() => null);
  if (!res.ok || !result) {
    const err = new Error(result?.error || `Podcast writer returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return result;
}

function fetchDraft(baseUrl, secret, slugPath, body, { attempts = 3, retryWriterErrors = false } = {}) {
  return withRetry(() => fetchDraftOnce(baseUrl, secret, slugPath, body), {
    attempts,
    baseMs: 4000,
    label: body?.action === "write-chapter" ? "write-chapter" : "podcast writer",
    // A chapter that fails the word-count/JSON validation is a transient model miss, not a dead run:
    // the next drafting attempt usually lands inside the range.
    retryIf: retryWriterErrors
      ? (error) => /did not return a valid|invalid or incomplete/i.test(String(error.message))
      : null,
  });
}

async function writeEpisode(episodesRoot) {
  const baseUrl = (process.env.TWK_AUTOMATION_URL || "").replace(/\/$/, "");
  const secret = process.env.AUTOMATION_INGEST_SECRET || "";
  if (!baseUrl || !secret) {
    throw new Error("--auto requires TWK_AUTOMATION_URL and AUTOMATION_INGEST_SECRET");
  }
  const params = new URLSearchParams({ format: "plan", minutes: args.minutes });
  if (args.story) params.set("story", args.story);
  if (args.writer) params.set("writer", args.writer);
  for (const source of args.source ?? []) params.append("source", source);
  const data = await fetchDraft(baseUrl, secret, `?${params}`);
  if (!data.pending) {
    log(`No episode queued (${data.reason || "none"}).`);
    return null;
  }
  if (!data.plan) throw new Error("The TWK deployment does not support chapter drafting yet.");

  const episode = data.plan;
  const outDir = args.out ? path.resolve(args.out) : path.join(episodesRoot, episode.slug);
  await mkdir(outDir, { recursive: true });
  const checkpoint = path.join(outDir, "draft-progress.json");
  // Always fetch the current plan first. A new source, outline, duration, writer,
  // or episode metadata invalidates reuse instead of resurrecting a stale draft.
  const requestKey = `scenes:${params}`;
  const draftKey = cacheKey({ schema: 1, requestKey, plan: episode });
  const localDraft = await readFile(checkpoint, "utf8").then(JSON.parse).catch(() => null);
  const previousDraft = await readCache(CACHE_DIR, "drafts", draftKey)
    .then((raw) => raw ? JSON.parse(raw.toString("utf8")) : null).catch(() => null);
  const reusableDraft = previousDraft || (localDraft?.draftKey === draftKey ? localDraft : null);
  const progress = reusableDraft?.requestKey === requestKey && Array.isArray(reusableDraft.completed)
    && reusableDraft.completed.length <= episode.chapters.length * 2
    && reusableDraft.completed.every((chapter) => Array.isArray(chapter.turns) && chapter.turns.length > 0)
    ? reusableDraft
    : { draftKey, requestKey, outlineModel: data.model, completed: [] };
  log(`Target: ${episode.targetMinutes} minutes across ${episode.chapters.length} chapters. Outline: ${progress.outlineModel}. Reused ${progress.completed.length} scenes.`);

  for (let scene = progress.completed.length; scene < episode.chapters.length * 2; scene++) {
    const index = Math.floor(scene / 2);
    const part = scene % 2;
    const previous = (progress.completed.at(-1)?.turns ?? []).slice(-3)
      .map((turn) => `${turn.speaker}: ${turn.text}`).join("\n").slice(-1200);
    const chapter = await fetchDraft(baseUrl, secret, "", {
      action: "write-chapter",
      plan: episode,
      index,
      part,
      previous,
      writer: args.writer,
    }, { attempts: 4, retryWriterErrors: true });
    progress.completed.push(chapter);
    const pendingCheckpoint = `${checkpoint}.tmp`;
    await writeFile(pendingCheckpoint, JSON.stringify(progress, null, 2));
    await rename(pendingCheckpoint, checkpoint);
    await writeCache(CACHE_DIR, "drafts", draftKey, JSON.stringify(progress)).catch((error) => {
      log(`Draft cache write skipped: ${error.code || error.message}`);
    });
    log(`Chapter ${index + 1}/${episode.chapters.length}, scene ${part + 1}/2: ${chapter.words} words (${chapter.model})`);
  }

  const { chapters: _chapters, sources: savedSources, ...metadata } = episode;
  const script = {
    ...metadata,
    title: `Episode ${metadata.episodeNumber}: ${metadata.title.replace(/^Episode \d+:\s*/i, "")}`,
    sources: savedSources.map(({ evidence, ...source }) => source),
    turns: progress.completed.flatMap(({ turns }) => turns),
    writerModels: [...new Set([progress.outlineModel, ...progress.completed.map(({ model }) => model)])],
  };
  await writeFile(path.join(outDir, "script.json"), JSON.stringify(script, null, 2));
  await rm(checkpoint, { force: true });
  return script;
}

async function main() {
  if (!args.episode && !args.auto) {
    console.error("Provide --episode <slug> or --auto");
    process.exit(1);
  }
  const episodesRoot = path.join(repoRoot, "podcast", "episodes");
  let script;
  let episodeSlug = args.episode;

  if (args.auto || !episodeSlug) {
    script = await writeEpisode(episodesRoot);
    if (!script) return;
    episodeSlug = script.slug;
  } else {
    const scriptPath = path.join(episodesRoot, episodeSlug, "script.json");
    script = JSON.parse(await readFile(scriptPath, "utf8"));
  }

  const episodeDir = path.join(episodesRoot, episodeSlug);
  const outDir = args.out ? path.resolve(args.out) : episodeDir;
  const activeProvider = args.provider;
  log(`Episode: ${script.title} (${script.turns.length} turns) | Provider: ${activeProvider}`);

  if (args["dry-run"] || args["draft-only"]) {
    log("Draft complete.");
    return;
  }

  if (!script.turns.some((turn) => turn.segment === "subscribe")) {
    throw new Error("The script has no mid-roll subscribe ask (segment: \"subscribe\"). Draft it through the TWK site, which adds the ask, before rendering.");
  }

  const ffmpegPath = await resolveFfmpeg();
  const tmpDir = await mkdir(path.join(os.tmpdir(), `twk-podcast-${Date.now()}`), { recursive: true });
  const pcmParts = [];
  const transcriptTurns = [];
  const chapters = [];
  let cursorSamples = 0;
  let lastChapter = null;

  try {
    const kit = {};
    for (const name of ["intro", "midroll", "outro"]) {
      kit[name] = await decodeAudioToFloat32(ffmpegPath, tmpDir, `kit-${name}`, await readFile(path.join(KIT_DIR, `${name}.mp3`)), "mp3");
    }
    // The intro's first INTRO_LEAD_S play alone; the rest is mixed under the opening lines below.
    const introLead = Math.min(kit.intro.length, Math.round(INTRO_LEAD_S * SAMPLE_RATE));
    pcmParts.push(kit.intro.slice(0, introLead));
    cursorSamples += introLead;

    // Synthesis dominates render time, so all turns are voiced first with a few requests in
    // flight, then assembled in script order. Assembly (gaps, kit, timestamps) is unchanged.
    const synthStarted = Date.now();
    let speechHits = 0;
    let speechMisses = 0;
    const renderedTurns = await mapWithConcurrency(script.turns, SYNTH_CONCURRENCY, async (turn, i) => {
      const speakerKey = turn.speaker === "B" ? "B" : "A";
      const voice = DEFAULT_VOICES[speakerKey];
      const rawSpeechSource = turn.ttsText || turn.text;
      const segments = rawSpeechSource
        .split(/(\[sfx:(?:notes|paper)\])/i)
        .filter((seg) => seg.trim().length > 0);
      const turnChunks = [];
      let noteFlip = false;

      for (let sIdx = 0; sIdx < segments.length; sIdx++) {
        const seg = segments[sIdx];
        if (/^\[sfx:(?:notes|paper)\]$/i.test(seg)) {
          noteFlip = true;
          continue;
        }
        const speechText = normalizeForSpeech(seg);
        if (!speechText) continue;
        let segSamples;
        if (activeProvider === "fish") {
          const speed = Number.isFinite(turn.speed) ? Math.max(0.9, Math.min(1.12, turn.speed)) : voice.fishSpeed;
          const { samples, hit } = await cachedSpeech({
            root: CACHE_DIR,
            identity: speechIdentity({ text: speechText, voice: voice.fishId, speed, model: activeFishModel }),
            synthesize: () => synthFishWithRetry(speechText, voice.fishId, speed),
            decode: (audio) => decodeAudioToFloat32(ffmpegPath, tmpDir, `${i}-${sIdx}`, audio, "mp3"),
            warn: log,
          });
          if (hit) speechHits++; else speechMisses++;
          segSamples = samples;
        } else {
          segSamples = await synthKokoro(speechText, voice.kokoroId);
        }
        const samples = trimSilence(segSamples);
        if (noteFlip) {
          const effect = makeNoteFlipSfx();
          for (let j = 0; j < Math.min(samples.length, effect.length); j++) samples[j] += effect[j] * 0.45;
          noteFlip = false;
        }
        turnChunks.push(samples);
      }

      const totalLen = turnChunks.reduce((sum, c) => sum + c.length, 0);
      const trimmed = new Float32Array(totalLen);
      let writeOffset = 0;
      for (const chunk of turnChunks) {
        trimmed.set(chunk, writeOffset);
        writeOffset += chunk.length;
      }
      return trimmed;
    });
    log(`Voiced ${script.turns.length} turns in ${((Date.now() - synthStarted) / 1000).toFixed(0)}s (${SYNTH_CONCURRENCY} in flight; speech cache ${speechHits} hits, ${speechMisses} misses)`);

    for (let i = 0; i < script.turns.length; i++) {
      const turn = script.turns[i];
      const speakerKey = turn.speaker === "B" ? "B" : "A";
      const voice = DEFAULT_VOICES[speakerKey];
      const trimmed = renderedTurns[i];

      if (turn.segment === "subscribe" && script.turns[i - 1]?.segment !== "subscribe") {
        for (const part of [silence(MIDROLL_BEFORE_S), kit.midroll, silence(MIDROLL_AFTER_S)]) {
          pcmParts.push(part);
          cursorSamples += part.length;
        }
      } else if (turn.chapter && turn.chapter !== lastChapter) {
        if (i > 0) {
          const gap = silence(CHAPTER_GAP_S);
          pcmParts.push(gap);
          cursorSamples += gap.length;
        }
        chapters.push({
          title: turn.chapter,
          startMs: Math.round((cursorSamples / SAMPLE_RATE) * 1000),
        });
        lastChapter = turn.chapter;
      } else if (i > 0) {
        const gap = silence(Number.isFinite(turn.pauseBeforeMs)
          ? Math.max(0, Math.min(1500, turn.pauseBeforeMs)) / 1000
          : TURN_GAP_S);
        pcmParts.push(gap);
        cursorSamples += gap.length;
      }

      const startMs = Math.round((cursorSamples / SAMPLE_RATE) * 1000);
      cursorSamples += trimmed.length;
      const endMs = Math.round((cursorSamples / SAMPLE_RATE) * 1000);
      pcmParts.push(trimmed);

      transcriptTurns.push({
        id: i + 1,
        speaker: voice.name,
        speakerRole: voice.role,
        speakerKey,
        chapter: turn.chapter || lastChapter,
        startMs,
        endMs,
        text: stripDeliveryTags(turn.text),
        citations: turn.citations || [],
        ...(turn.segment === "subscribe" ? { segment: "subscribe" } : {}),
      });

      log(`  Turn ${i + 1}/${script.turns.length} (${voice.name}): ${((endMs - startMs) / 1000).toFixed(1)}s`);
    }

    for (const part of [silence(OUTRO_GAP_S), kit.outro]) {
      pcmParts.push(part);
      cursorSamples += part.length;
    }
    const mixed = new Float32Array(cursorSamples);
    let at = 0;
    for (const part of pcmParts) {
      mixed.set(part, at);
      at += part.length;
    }
    // The rest of the intro continues under the opening lines: ducked so the speech stays in
    // front, ramped down over the duck-in, and faded out over its last seconds.
    const introTail = kit.intro.subarray(introLead);
    const duckGain = 0.45;
    const duckRamp = Math.min(Math.round(0.25 * SAMPLE_RATE), introTail.length);
    const fadeLen = Math.min(Math.round(2.5 * SAMPLE_RATE), introTail.length);
    for (let j = 0; j < introTail.length && introLead + j < mixed.length; j++) {
      const ramp = duckRamp > 0 ? Math.min(1, j / duckRamp) : 1;
      const gain = 1 - (1 - duckGain) * ramp;
      const fade = fadeLen > 0 ? Math.min(1, (introTail.length - j) / fadeLen) : 1;
      mixed[introLead + j] += introTail[j] * gain * fade;
    }
    pcmParts.length = 0;
    pcmParts.push(mixed);

    await mkdir(outDir, { recursive: true });
    const wavPath = path.join(tmpDir, "episode.wav");
    const mp3Path = path.join(outDir, "episode.mp3");
    const seconds = cursorSamples / SAMPLE_RATE;
    const bitrate = [128, 112, 96, 80, 64, 56, 48].find((rate) => (rate * 1000 * seconds) / 8 < 46_000_000) ?? 48;
    await writeFile(wavPath, encodeWav(pcmParts));

    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      wavPath,
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-codec:a",
      "libmp3lame",
      "-ar",
      "24000",
      "-b:a",
      `${bitrate}k`,
      mp3Path,
    ]);

    const mp3Stat = await stat(mp3Path);
    const durationSeconds = Number((cursorSamples / SAMPLE_RATE).toFixed(2));

    const transcriptDoc = {
      slug: script.slug,
      title: script.title,
      episodeNumber: script.episodeNumber,
      durationSeconds,
      chapters,
      sources: script.sources || [],
      turns: transcriptTurns,
    };

    const manifestDoc = {
      slug: script.slug,
      episodeNumber: script.episodeNumber,
      title: script.title,
      description: script.description,
      publishedAt: script.publishedAt || new Date().toISOString(),
      durationSeconds,
      bytes: mp3Stat.size,
      provider: activeProvider,
      model: activeProvider === "fish" ? activeFishModel : KOKORO_MODEL_ID,
      hosts: {
        A: { name: DEFAULT_VOICES.A.name, role: DEFAULT_VOICES.A.role },
        B: { name: DEFAULT_VOICES.B.name, role: DEFAULT_VOICES.B.role },
      },
      chapters,
      sources: script.sources || [],
      aiDisclosure: `${SHOW_NAME} is AI-hosted and produced by TechWhoKnows.`,
      audioKit: "who-knows-v1",
    };

    await writeFile(path.join(outDir, "transcript.json"), JSON.stringify(transcriptDoc, null, 2), "utf8");
    await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifestDoc, null, 2), "utf8");
    await rebuildRssFeed(episodesRoot);

    log(`Done! ${mp3Path} (${(mp3Stat.size / 1024 / 1024).toFixed(2)} MB, ${durationSeconds}s)`);

    if (args.publish) {
      if (mp3Stat.size > 50_000_000) throw new Error("The rendered MP3 exceeds the publisher's 50 MB safety limit. The local file is ready; review that limit before uploading larger files.");
      await publishToTwk(script.slug, outDir, episodesRoot);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function publishToTwk(slug, outDir, episodesRoot) {
  const baseUrl = (process.env.TWK_AUTOMATION_URL || "").replace(/\/$/, "");
  const secret = process.env.AUTOMATION_INGEST_SECRET || "";
  if (!baseUrl || !secret) {
    log("Skipping website publish (TWK_AUTOMATION_URL / AUTOMATION_INGEST_SECRET not set).");
    return;
  }

  log(`Publishing ${slug} to ${baseUrl}...`);
  const files = [
    ["mp3", path.join(outDir, "episode.mp3"), "audio/mpeg"],
    ["transcript", path.join(outDir, "transcript.json"), "application/json"],
    ["manifest", path.join(outDir, "manifest.json"), "application/json"],
    ["feed", path.join(episodesRoot, "feed.xml"), "application/xml"],
  ];
  const doneJson = await publishPodcastFiles({ baseUrl, secret, slug, files, log });
  log(`Published to ${doneJson.episodeUrl} | IndexNow: ${doneJson.indexing?.indexNow?.message || "ok"}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error("[twk-podcast] FATAL:", err);
    process.exitCode = 1;
  }).finally(() => pruneCache(CACHE_DIR).catch((error) => {
    log(`Cache cleanup skipped: ${error.code || error.message}`);
  }));
}

export { normalizeForSpeech, stripDeliveryTags, trimSilence, encodeWav, makeNoteFlipSfx, withRetry, mapWithConcurrency };
