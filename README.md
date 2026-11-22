# twk-audio

Makes the "Listen" audio on [TechWhoKnows](https://techwhoknows.com) articles.

When the site publishes a story it sends a `repository_dispatch` (`article-audio`) to this repo. A GitHub Actions job then asks the site which published stories have no current audio. It reads each one with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open-weight speech model under the Apache 2.0 licence, using the British voice `bf_emma`. The audio is encoded as a mono 48 kbps MP3 and uploaded through a one-time signed URL.

The hourly `cron` is only a backstop: GitHub often delays scheduled runs by 5 to 10 hours, so don't rely on it.

Nothing here decides what gets read. The site builds the text, keeps the audio manifests and serves the player, so changes to the reading rules happen in the main site repo. This repo only runs the voice model, and it is public so the runners are free.

## Run it locally

```bash
npm ci
TWK_AUTOMATION_URL=https://techwhoknows.com AUTOMATION_INGEST_SECRET=... node generate.mjs --limit 20
```

Try a voice without touching the site:

```bash
node generate.mjs --sample "Nvidia reported revenue of 40 billion dollars." --voice bm_george --out ./out
```

Other options are `--shard 0/3` (split a backfill across parallel workers), `--max-minutes`, `--dtype` (default `fp32`, faster on CPU than `q8`) and `--dry-run`.

Transient errors (timeouts, 429, 5xx) retry with backoff: story fetches, uploads, Fish TTS calls and podcast chapter drafting all retry instead of killing the run, and an invalid writer chapter is retried too. If the Fish plan rejects the paid model, the podcast renderer drops to `s2.1-pro-free` for the rest of the run.

Podcast renders voice turns with a few requests in flight (assembly still follows script order). Tune with `TWK_SYNTH_CONCURRENCY` (default 3, max 6).

## Podcast publication requests

Final publication uses `podcast/publish.mjs`. API calls have a 30-second deadline;
each file PUT has a 180-second deadline. Signed-URL requests and identical-byte
PUTs retry transient failures at most three times, with fresh deadlines. All four
local files and distinct HTTPS upload targets are checked before the first PUT.
Bearer tokens, signed URLs and remote error bodies are not included in errors.

Website completion is one attempt, not an automatic retry. A timeout, lost response
or bad response can follow a committed index update. Check the website episode and
index before rerunning publication. Local rendered files remain available. The
existing 50 MB publisher safety limit remains; it is not a claim about R2's limit.

## Tests

```bash
npm test
```

Pure helpers (chunking, trimming, WAV encoding, speech normalization, retry and concurrency) are covered by node:test unit tests; they need no model download.

## Secrets

The workflow needs two repository secrets, `TWK_AUTOMATION_URL` and `AUTOMATION_INGEST_SECRET`. GitHub masks them in logs, and workflows triggered by pull requests from forks don't receive them.

### Podcast workflow reuse

The podcast workflow keeps the existing shared `node_modules` cache and also
restores `.cache/podcast` before generation. It saves a new snapshot after both
successful and failed generations, so a retry can reuse completed work:

- Draft scenes are keyed by the full current plan and request options. The site
  is still asked for the current plan first. Changed plans are drafted afresh;
  metadata and source evidence are not stored in the draft cache.
- Fish MP3 segments are keyed by normalized speech text, voice, speed, model,
  and synthesis settings. Changed segments alone need new synthesis. A fallback
  result is stored under the model actually requested for that response.
- Cached audio must decode to nonempty finite samples. Invalid entries are
  discarded and synthesized again. Voice settings, order, mix, and publishing
  checks are unchanged. Logs report hit/miss counts.
- The local work cache is capped at 512 MiB by pruning old entries. Cache misses,
  expiry, or eviction only cause recomputation. A completely new episode still
  needs drafting and speech, so this mostly speeds retries and revisions, not
  first-time generation of new material.

Set `TWK_PODCAST_CACHE_DIR` to change its local location. Delete `.cache/podcast`
to force fresh synthesis. Cache snapshots contain generated scripts/audio, not
credentials. As with other GitHub Actions caches in this public repository,
assume their contents can be read by repository users: never put secrets or
unpublished confidential material in this cache.

Both workflows skip ONNX's optional CUDA download on CPU-only GitHub runners.
The CPU runtime is still installed; Fish remains the production podcast voice.

`node scripts/benchmark-cache.mjs` runs a local mock writer/TTS service, renders
twice through real ffmpeg, and checks that the warm render makes no writer/TTS
calls and produces a byte-identical MP3. It does not call Fish or publish.
The Audio tests workflow runs this check and the unit tests on code changes.
