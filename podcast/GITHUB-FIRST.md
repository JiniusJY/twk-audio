# GitHub-first podcast path

Preparation only. Do not merge or release until the owner approves the selected release.

The workflow requests one authenticated `format=source-export` snapshot from TWK, then retrieves recorded upstream sources, writes and independently reviews the episode through the direct NVIDIA endpoint, synthesizes through direct Fish, and assembles on the GitHub runner. Vercel keeps publication URL signing, catalogue completion and normal page/feed serving. No website build is needed for a later content-only episode update.

Required encrypted repository secrets:
- Existing `TWK_AUTOMATION_URL` and `AUTOMATION_INGEST_SECRET`.
- `NVIDIA_API_KEY` and `FISH_AUDIO_API_KEY`. These must be securely supplied before enabling direct production runs. No credentials belong in source, logs or artifacts.

The provider selection is NVIDIA as requested by the owner. The vendor's Developer Program restrictions still apply. There is no AI Gateway fallback, no automatic paid provider, and no bypass of service refusal. If both configured NVIDIA models contribute to writing, no independent reviewer remains and the episode stops rather than reviewing itself. Fish is pinned to `s2.1-pro-free` and stops at the verified free-window cutoff. The free endpoint has fair-use/retention and availability limits.

Release order: website source-export endpoint first, then audio branch with secrets ready. Keep both draft PRs unmerged while preparing. Existing web writer/relay APIs remain for compatibility, but direct-mode jobs do not call them. Existing voices and fixed subscription break are preserved via the runtime source snapshot. Fact checks and audio listening remain required; mocked tests are not a final listening check.

Media persists in R2. A corrected MP3 uses a content-derived version; episode GUID and original date remain stable. Infrastructure quotas still apply. This design reduces Vercel generation work; it does not promise a zero site bill.
