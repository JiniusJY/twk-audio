#!/usr/bin/env node
/**
 * Generates multi-speaker TechWhoKnows podcast episodes with exact millisecond
 * transcript timestamps, chapter markers, and a Podcast RSS 2.0 feed.
 *
 * Supports two TTS providers:
 *   - fish   : Fish Audio API (default: s2.1-pro-free; set FISH_AUDIO_MODEL=s2.1-pro later)
 *   - kokoro : Open-weight Kokoro-82M ONNX (Apache 2.0, $0 forever fallback)
 *
 * Usage:
 *   node podcast/generate-podcast.mjs --episode ep-01-asean-compute-race
 *   node podcast/generate-podcast.mjs --episode ep-01-asean-compute-race --provider kokoro
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const { values: args } = parseArgs({
  options: {
    episode: { type: "string" },
    provider: { type: "string", default: process.env.TTS_PROVIDER || "fish" },
    "fish-model": { type: "string", default: process.env.FISH_AUDIO_MODEL || "s2.1-pro-free" },
    "auto-fallback": { type: "boolean", default: true },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!args.episode) {
  console.error("Missing required --episode <slug>");
  process.exit(1);
}

const SAMPLE_RATE = 24000;
const TURN_GAP_S = 0.26;
const CHAPTER_GAP_S = 0.65;
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

const DEFAULT_VOICES = {
  A: {
    name: "Jade",
    role: "Lead Tech Editor",
    fishId: process.env.FISH_VOICE_A || "6ab4c6b0f37f4243a99046478647be94",
    kokoroId: process.env.KOKORO_VOICE_A || "bf_emma",
  },
  B: {
    name: "Alok",
    role: "Systems & Infrastructure Analyst",
    fishId: process.env.FISH_VOICE_B || "b7204d4e40ef4a548c7c8547b7f73492",
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
  return buffer;
}

/** Strip Fish Audio delivery tags like [chuckles], [sighs], [pauses] when falling back to Kokoro. */
function stripDeliveryTags(text) {
  return text.replace(/\[[^\]]{1,32}\]\s*/g, "").replace(/\s+/g, " ").trim();
}

async function synthFish(text, referenceId, model) {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    const err = new Error("FISH_AUDIO_API_KEY is not set");
    err.fallbackable = true;
    throw err;
  }
  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      model,
    },
    body: JSON.stringify({
      text,
      reference_id: referenceId,
      format: "mp3",
      mp3_bitrate: 128,
      normalize: true,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Fish Audio ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    err.fallbackable = res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

let kokoroInstance = null;
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
    <title>TechWhoKnows Deep Dive</title>
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

async function main() {
  const episodesRoot = path.join(repoRoot, "podcast", "episodes");
  const episodeDir = path.join(episodesRoot, args.episode);
  const outDir = args.out ? path.resolve(args.out) : episodeDir;
  const scriptPath = path.join(episodeDir, "script.json");

  const script = JSON.parse(await readFile(scriptPath, "utf8"));
  const ffmpegPath = await resolveFfmpeg();
  const tmpDir = await mkdir(path.join(os.tmpdir(), `twk-podcast-${Date.now()}`), { recursive: true });

  let activeProvider = args.provider;
  log(`Episode: ${script.title} (${script.turns.length} turns) | Provider: ${activeProvider}`);

  if (args["dry-run"]) {
    log("Dry run complete. Script is valid.");
    return;
  }

  const pcmParts = [];
  const transcriptTurns = [];
  const chapters = [];
  let cursorSamples = 0;
  let lastChapter = null;

  try {
    for (let i = 0; i < script.turns.length; i++) {
      const turn = script.turns[i];
      const speakerKey = turn.speaker === "B" ? "B" : "A";
      const voice = DEFAULT_VOICES[speakerKey];

      if (turn.chapter && turn.chapter !== lastChapter) {
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
        const gap = silence(TURN_GAP_S);
        pcmParts.push(gap);
        cursorSamples += gap.length;
      }

      let samples;
      if (activeProvider === "fish") {
        try {
          const mp3Buf = await synthFish(turn.text, voice.fishId, args["fish-model"]);
          samples = await decodeAudioToFloat32(ffmpegPath, tmpDir, i, mp3Buf, "mp3");
        } catch (err) {
          if (args["auto-fallback"] && err.fallbackable) {
            log(`Fish Audio unavailable (${err.message}); falling back to Kokoro-82M.`);
            activeProvider = "kokoro";
            samples = await synthKokoro(turn.text, voice.kokoroId);
          } else {
            throw err;
          }
        }
      } else {
        samples = await synthKokoro(turn.text, voice.kokoroId);
      }

      const trimmed = trimSilence(samples);
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
      });

      log(`  Turn ${i + 1}/${script.turns.length} (${voice.name}): ${((endMs - startMs) / 1000).toFixed(1)}s`);
    }

    await mkdir(outDir, { recursive: true });
    const wavPath = path.join(tmpDir, "episode.wav");
    const mp3Path = path.join(outDir, "episode.mp3");
    await writeFile(wavPath, encodeWav(pcmParts));

    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      wavPath,
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      mp3Path,
    ]);

    const mp3Stat = await readFile(mp3Path);
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
      bytes: mp3Stat.byteLength,
      provider: activeProvider,
      model: activeProvider === "fish" ? args["fish-model"] : KOKORO_MODEL_ID,
      hosts: {
        A: { name: DEFAULT_VOICES.A.name, role: DEFAULT_VOICES.A.role },
        B: { name: DEFAULT_VOICES.B.name, role: DEFAULT_VOICES.B.role },
      },
      chapters,
      sources: script.sources || [],
      aiDisclosure: "AI-hosted technical deep dive produced by TechWhoKnows.",
    };

    await writeFile(path.join(outDir, "transcript.json"), JSON.stringify(transcriptDoc, null, 2), "utf8");
    await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifestDoc, null, 2), "utf8");
    await rebuildRssFeed(episodesRoot);

    log(`Done! ${mp3Path} (${(mp3Stat.byteLength / 1024 / 1024).toFixed(2)} MB, ${durationSeconds}s)`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[twk-podcast] FATAL:", err);
  process.exit(1);
});
