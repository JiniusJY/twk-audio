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

## Secrets

The workflow needs two repository secrets, `TWK_AUTOMATION_URL` and `AUTOMATION_INGEST_SECRET`. GitHub masks them in logs, and workflows triggered by pull requests from forks don't receive them.
