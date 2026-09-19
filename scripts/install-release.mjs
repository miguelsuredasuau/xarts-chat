#!/usr/bin/env node
// Registers the labelled BASELINE package (used only while Promote has activated nothing)
// and installs whichever release is currently resolved.
//
//   node scripts/install-release.mjs baseline --tarball <visx-render-*.tgz> --sha <full git sha> [--note "..."]
//   node scripts/install-release.mjs current      # install/verify what the next request will use
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LOCAL_REGISTRY, resolveRelease, ensureInstalled, describeRelease, sha256File } from '../lib/release.mjs';
import { ROOT } from '../lib/paths.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { tarball: { type: 'string' }, sha: { type: 'string' }, note: { type: 'string' } },
});
const mode = positionals[0] ?? 'current';

if (mode === 'baseline') {
  const tarball = resolve(values.tarball ?? join(ROOT, '.cache/xarts-e9059b4b/out-sdk-baseline/visx-render-0.5.0-local.sha-1bb2bab64ae8.tgz'));
  const sha = values.sha ?? '45c2b2429a54e2b212619a1efaf4040bbd4107a3';
  if (!existsSync(tarball)) throw new Error(`Tarball not found: ${tarball}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--sha must be a full 40-character git sha');
  const packageHash = sha256File(tarball);
  const version = tarball.match(/visx-render-(.+)\.tgz$/)?.[1] ?? null;
  mkdirSync(join(LOCAL_REGISTRY, 'packages'), { recursive: true });
  copyFileSync(tarball, join(LOCAL_REGISTRY, 'packages', `${packageHash}.tgz`));
  const record = {
    schemaVersion: 1,
    kind: 'baseline',
    label: `Baseline ${sha.slice(0, 8)} — not a Promote release`,
    sourceSha: sha,
    packageHash,
    version,
    createdAt: new Date().toISOString(),
    note: values.note ?? 'Last main commit whose SDK package builds. main@e3ebca5e fails `build-sdk` (first bad commit e9059b4b: TS2339 on augmented EscuchaDeclarada fields). Replaced automatically as soon as Promote activates a release.',
  };
  writeFileSync(join(LOCAL_REGISTRY, 'baseline.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[ok] baseline registered: ${record.label} · ${packageHash.slice(0, 12)}`);
}

const release = resolveRelease();
const dir = ensureInstalled(release);
console.log(JSON.stringify({ ...describeRelease(release), installedAt: dir }, null, 2));
