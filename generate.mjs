#!/usr/bin/env node
/**
 * Generates "Listen" audio for TechWhoKnows articles with Kokoro (open-weight, Apache 2.0).
 * Home: github.com/Zyllobrew/twk-audio (public, so GitHub Actions minutes are free).
 *
 * It asks the site which published stories have no current audio, reads each one with
 * Kokoro on the CPU, encodes a small mono MP3 and uploads it through a signed URL. The site
 * never hands out storage keys; the only secret this needs is AUTOMATION_INGEST_SECRET.
 *
 *   node generate.mjs                     # process pending stories (default limit 40)
 *   node generate.mjs --limit 200         # backfill
 *   node generate.mjs --max-minutes 25    # stop cleanly before a CI timeout
 *   node generate.mjs --shard 0/3 --limit 500       # one of three parallel backfill workers
 *   node generate.mjs --sample "Text" --out ./out   # local voice test, no network
 *
 * Env: TWK_AUTOMATION_URL, AUTOMATION_INGEST_SECRET, KOKORO_CACHE_DIR (model cache).
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    limit: { type: "string", default: "40" },
    "max-minutes": { type: "string", default: "0" },
    voice: { type: "string", default: process.env.TWK_AUDIO_VOICE || "bf_emma" },
    dtype: { type: "string", default: "fp32" },
    speed: { type: "string", default: "1" },
    out: { type: "string" },
    sample: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    shard: { type: "string", default: "0/1" },
  },
});

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SAMPLE_RATE = 24000;
const PARAGRAPH_GAP_S = 0.45;
const SENTENCE_GAP_S = 0.12;
const MAX_CHUNK_CHARS = 280;
const startedAt = Date.now();
const maxMs = Number(args["max-minutes"]) * 60_000;

const baseUrl = (process.env.TWK_AUTOMATION_URL || "").replace(/\/$/, "");
const secret = process.env.AUTOMATION_INGEST_SECRET || "";

function log(...parts) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(0).padStart(4, " ");
  console.log(`[${secs}s]`, ...parts);
}

async function api(method, body, query = "") {
  const res = await fetch(`${baseUrl}/api/automation/audio${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(`${method} audio API ${res.status}: ${json.error || "failed"}`);
  return json;
}

/** Paragraphs stay apart (longer pause); long paragraphs split at sentence ends into model-sized chunks. */
export function chunkSpeech(text) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return paragraphs.map((paragraph) => {
    const sentences = paragraph.split(/(?<=[.!?…]["'”’)]?)\s+(?=["'“‘(]?[A-Z0-9])/);
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
      if (sentence.length > MAX_CHUNK_CHARS) {
        if (current) chunks.push(current);
        current = "";
        // A run-on sentence: break at commas/semicolons, then at spaces as a last resort.
        let rest = sentence;
        while (rest.length > MAX_CHUNK_CHARS) {
          const window = rest.slice(0, MAX_CHUNK_CHARS);
          const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
          const at = cut > 80 ? cut + 1 : window.lastIndexOf(" ");
          chunks.push(rest.slice(0, at > 0 ? at : MAX_CHUNK_CHARS).trim());
          rest = rest.slice(at > 0 ? at : MAX_CHUNK_CHARS).trim();
        }
        current = rest;
        continue;
      }
      if (current && current.length + sentence.length + 1 > MAX_CHUNK_CHARS) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  });
}

/** Kokoro pads every clip with uneven silence; trim it so the gaps we add are the gaps you hear. */
function trimSilence(samples, threshold = 0.008) {
  let start = 0;
  let end = samples.length - 1;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end]) < threshold) end--;
  const pad = Math.round(SAMPLE_RATE * 0.03);
  return samples.subarray(Math.max(0, start - pad), Math.min(samples.length, end + pad + 1));
}

function silence(seconds) {
  return new Float32Array(Math.round(SAMPLE_RATE * seconds));
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
  return { wav: buffer, seconds: total / SAMPLE_RATE };
}

async function ffmpegPath() {
  try {
    const mod = await import("ffmpeg-static");
    if (mod.default) return mod.default;
  } catch {
    // fall through to PATH
  }
  return "ffmpeg";
}

async function toMp3(wav, ffmpeg) {
  const dir = path.join(os.tmpdir(), "twk-audio");
  await mkdir(dir, { recursive: true });
  const id = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const inFile = path.join(dir, `${id}.wav`);
  const outFile = path.join(dir, `${id}.mp3`);
  await writeFile(inFile, wav);
  await new Promise((resolve, reject) => {
    // Mono speech: 48 kbps at 24 kHz is clear on phone speakers and ~0.36 MB a minute.
    const proc = spawn(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-y", "-i", inFile, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ar", String(SAMPLE_RATE), "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "48k", outFile],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`))));
  });
  const mp3 = await readFile(outFile);
  await Promise.all([rm(inFile, { force: true }), rm(outFile, { force: true })]);
  return mp3;
}

async function loadModel() {
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = process.env.KOKORO_CACHE_DIR || path.join(here, ".cache", "models");
  const { KokoroTTS } = await import("kokoro-js");
  log(`Loading Kokoro (${args.dtype}) from ${env.cacheDir}`);
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: args.dtype, device: "cpu" });
  log("Model ready");
  return tts;
}

async function speak(tts, text) {
  const paragraphs = chunkSpeech(text);
  const out = [];
  for (let pi = 0; pi < paragraphs.length; pi++) {
    if (pi > 0) out.push(silence(PARAGRAPH_GAP_S));
    for (let ci = 0; ci < paragraphs[pi].length; ci++) {
      if (ci > 0) out.push(silence(SENTENCE_GAP_S));
      const audio = await tts.generate(paragraphs[pi][ci], { voice: args.voice, speed: Number(args.speed) });
      out.push(trimSilence(audio.audio));
    }
  }
  return encodeWav(out);
}

async function uploadStory(story, mp3, seconds) {
  const { signedUrl } = await api("POST", { action: "upload-url", postId: story.id, hash: story.hash });
  const put = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/mpeg", "cache-control": "max-age=31536000", "x-upsert": "true" },
    body: mp3,
  });
  if (!put.ok) throw new Error(`Upload failed ${put.status}: ${(await put.text()).slice(0, 200)}`);
  await api("POST", {
    action: "complete",
    postId: story.id,
    hash: story.hash,
    durationSeconds: Math.round(seconds),
    bytes: mp3.length,
    voice: args.voice,
  });
}

async function main() {
  const ffmpeg = await ffmpegPath();

  if (args.sample) {
    const tts = await loadModel();
    const t0 = Date.now();
    const { wav, seconds } = await speak(tts, args.sample);
    const took = (Date.now() - t0) / 1000;
    const mp3 = await toMp3(wav, ffmpeg);
    const outDir = args.out || here;
    await mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `sample-${args.voice}.mp3`);
    await writeFile(file, mp3);
    log(`${seconds.toFixed(1)}s of audio in ${took.toFixed(1)}s (${(seconds / took).toFixed(2)}x real time) -> ${file}`);
    return;
  }

  if (!baseUrl || !secret) throw new Error("Set TWK_AUTOMATION_URL and AUTOMATION_INGEST_SECRET.");

  const [shardIndex, shardCount] = args.shard.split("/").map(Number);
  const { pending: all, total } = await api("GET", null, `?limit=${Number(args.limit) || 40}&voice=${args.voice}`);
  const pending = all.filter((_, i) => i % (shardCount || 1) === (shardIndex || 0));
  log(`${pending.length} stories to read in this worker (${all.length} waiting, ${total} published)`);
  if (pending.length === 0) return;

  const tts = await loadModel();
  let done = 0;
  let failed = 0;
  let audioSeconds = 0;
  let inflight = Promise.resolve();

  for (const story of pending) {
    if (maxMs && Date.now() - startedAt > maxMs) {
      log("Time budget reached; the next run picks up the rest.");
      break;
    }
    try {
      const t0 = Date.now();
      const { wav, seconds } = await speak(tts, story.text);
      const genSecs = (Date.now() - t0) / 1000;
      // Encode and upload while the next story is being read.
      await inflight;
      inflight = (async () => {
        try {
          const mp3 = await toMp3(wav, ffmpeg);
          if (args.out) {
            await mkdir(args.out, { recursive: true });
            await writeFile(path.join(args.out, `${story.slug}.mp3`), mp3);
          }
          if (!args["dry-run"]) await uploadStory(story, mp3, seconds);
          done++;
          audioSeconds += seconds;
          log(`ok ${story.slug} ${Math.round(seconds)}s audio, ${genSecs.toFixed(0)}s to read, ${(mp3.length / 1e6).toFixed(2)} MB`);
        } catch (error) {
          failed++;
          log(`FAILED ${story.slug}: ${error.message}`);
        }
      })();
    } catch (error) {
      failed++;
      log(`FAILED ${story.slug}: ${error.message}`);
    }
  }
  await inflight;
  log(`Done: ${done} uploaded, ${failed} failed, ${(audioSeconds / 60).toFixed(1)} min of audio.`);
  if (failed > 0 && done === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
