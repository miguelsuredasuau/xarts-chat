# Release registry: how Promote hands a new Xarts version to xarts-chat

**Audience:** whoever implements Promote's release step (W08).
**Status:** xarts-chat implements the reading side (`lib/release.mjs`, covered by `npm test`). Promote does not write this yet.

## Rule

xarts-chat always renders with the release **Promote has activated**. Only when Promote has activated nothing does it fall back to a labelled baseline. If an activated release cannot be verified, xarts-chat **refuses to render** rather than quietly using an older version.

The active version is read at the start of each chat turn and never changes during one. Every run record names the release that produced it.

## Layout

Promote owns one directory. xarts-chat reads it through `PROMOTE_REGISTRY=/path/to/registry`.

```
<registry>/
  active.json                   → which release is live
  releases/<releaseId>.json     → one immutable record per release
  packages/<packageHash>.tgz    → the exact accepted tarball, named by its sha256
```

### `active.json`

```json
{ "schemaVersion": 1, "releaseId": "rel-2026-09-19-001", "activatedAt": "2026-09-19T14:02:11Z" }
```

`releaseId` must match `^[A-Za-z0-9._-]{1,128}$`. Write it atomically: write a temp file, then rename it. Rollback means pointing `active.json` back at `priorReleaseId`.

### `releases/<releaseId>.json`

This is Promote's existing `Release` record (`contracts/records.ts`) plus one optional `package` block:

```json
{
  "schemaVersion": 1,
  "id": "rel-2026-09-19-001",
  "incidentId": "inc-…",
  "acceptedSha": "<40-char git sha the package was built from>",
  "packageHash": "<sha256 of the tarball>",
  "outputArtifactHash": "…",
  "manifestHash": "…",
  "gateResultIds": ["…"],
  "priorReleaseId": null,
  "destination": "local_demo_registry",
  "activatedAt": "2026-09-19T14:02:11Z",
  "package": { "name": "visx-render", "version": "0.5.0-local.sha-…" }
}
```

xarts-chat checks that `id` equals `active.json.releaseId`, and that `packages/<packageHash>.tgz` exists and hashes to `packageHash`. Records are immutable: a new build is a new release.

### `packages/<packageHash>.tgz`

This is the `visx-render-*.tgz` produced by `render-cli/build-sdk.mjs` for the accepted commit. It must be byte-identical to what the A08 package gate evaluated.

## What makes a release usable by xarts-chat without workarounds

The current baseline needs two runtime workarounds (see [FINDINGS.md](FINDINGS.md)). A release that fixes the packaging defects needs none, and the record's `release.shims` becomes `[]`. That's the simplest visible proof in the UI that a Promote release improved the library.

## Feedback path: run records → Promote

Every chat turn writes `runs/outbox/<runId>.json` ([RUN-RECORD.md](RUN-RECORD.md)). Promote reads the outbox and triages `signals`. A record showing that a failure has disappeared under a newer release is the evidence for gate A10, "repeat benefit".
