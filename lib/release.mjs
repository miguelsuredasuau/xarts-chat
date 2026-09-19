import { ActiveRelease, ReleaseEnvelope } from './registry-wire.mjs';
// Which Xarts package renders the next request.
//
// Rule: a Promote-activated release wins. Only when Promote has activated
// nothing does the chat fall back to the labelled baseline. If Promote HAS an
// active release but it cannot be verified (missing tarball, hash mismatch,
// failed install), the chat refuses to render: it never silently falls back
// to an older version while claiming to run the latest one.
//
// Registry layout (see docs/RELEASE-REGISTRY.md):
//   <registry>/active.json                 { schemaVersion, releaseId, activatedAt }
//   <registry>/releases/<releaseId>.json   Promote `Release` record (+ package metadata)
//   <registry>/packages/<packageHash>.tgz  the exact accepted tarball
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, symlinkSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './paths.mjs';

export const LOCAL_REGISTRY = join(ROOT, 'registry');
export const PROMOTE_REGISTRY = process.env.PROMOTE_REGISTRY ? resolve(process.env.PROMOTE_REGISTRY) : null;
const RUNTIME = join(ROOT, 'runtime');
const REACT = '18.3.1';

export class ReleaseError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export const sha256File = file => createHash('sha256').update(readFileSync(file)).digest('hex');

const hashMemo = new Map();
function verifiedTarball(registry, packageHash) {
  if (!/^[0-9a-f]{64}$/.test(packageHash ?? '')) throw new ReleaseError('bad_release', `packageHash is not a sha256: ${packageHash}`);
  const tarball = join(registry, 'packages', `${packageHash}.tgz`);
  if (!existsSync(tarball)) throw new ReleaseError('missing_package', `Tarball not found: ${tarball}`);
  // Re-hash only when the file changes (size/mtime); the tarball is tens of MB.
  const st = statSync(tarball);
  const key = `${tarball}:${st.size}:${st.mtimeMs}`;
  const actual = hashMemo.get(key) ?? sha256File(tarball);
  hashMemo.set(key, actual);
  if (actual !== packageHash) throw new ReleaseError('hash_mismatch', `Tarball hash ${actual} ≠ release packageHash ${packageHash}`);
  return tarball;
}

/** The release the next request must use. Throws ReleaseError instead of guessing. */
export function resolveRelease({ promote = PROMOTE_REGISTRY, local = LOCAL_REGISTRY } = {}) {
  if (promote && existsSync(join(promote, 'active.json'))) {
    const parsedActive = ActiveRelease.safeParse(readJson(join(promote, 'active.json')));
    if (!parsedActive.success) throw new ReleaseError('bad_release', 'Invalid active release pointer');
    const active = parsedActive.data;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(active.releaseId ?? '')) throw new ReleaseError('bad_release', 'active.json releaseId is missing or not a safe identifier');
    const file = join(promote, 'releases', `${active.releaseId}.json`);
    if (!existsSync(file)) throw new ReleaseError('missing_release', `Active release record not found: ${file}`);
    const parsed = ReleaseEnvelope.safeParse(readJson(file));
    if (!parsed.success) throw new ReleaseError('bad_release', 'Release provenance is incomplete or invalid');
    const rec = parsed.data;
    if (rec.id !== active.releaseId) throw new ReleaseError('bad_release', 'Release record id does not match active.json');
    const tarball = verifiedTarball(promote, rec.packageHash);
    return {
      kind: 'promote',
      label: `Promote release ${rec.id}`,
      releaseId: rec.id,
      incidentId: rec.incidentId ?? null,
      sourceSha: rec.acceptedSha,
      packageHash: rec.packageHash,
      version: rec.package?.version ?? null,
      activatedAt: active.activatedAt ?? rec.activatedAt ?? null,
      priorReleaseId: rec.priorReleaseId ?? null,
      tarball,
    };
  }
  const file = join(local, 'baseline.json');
  if (!existsSync(file)) throw new ReleaseError('no_release', 'No Promote release is active and no baseline is installed. Run `npm run release:baseline`.');
  const rec = readJson(file);
  return {
    kind: 'baseline',
    label: rec.label,
    releaseId: null,
    incidentId: null,
    sourceSha: rec.sourceSha,
    packageHash: rec.packageHash,
    version: rec.version,
    activatedAt: rec.createdAt,
    priorReleaseId: null,
    note: rec.note,
    tarball: verifiedTarball(local, rec.packageHash),
  };
}

// Runtime shims: applied to the INSTALLED copy only; the tarball bytes stay verified.
// Each one exists because of a measured packaging defect and must disappear when a
// release fixes it. They are recorded in every run so no chart hides behind them.
export const SHIMS = {
  'ts-loader': 'Render process runs with `--import tsx`: the package bundles @anlak/ui-kit as raw .ts/.tsx source, which Node refuses to strip under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Reproduced by the repo\'s own render-cli/sdk/check-consumer.mjs.',
  'core-symlink': 'visx-render/node_modules/core → ../core: bundled @anlak/ui-kit imports `../../../core/layout` and `../../../core/theme/*`, paths that only exist inside the monorepo.',
};

function applyShims(pkgDir) {
  const applied = [];
  const kit = join(pkgDir, 'node_modules', '@anlak', 'ui-kit');
  if (existsSync(join(kit, 'package.json'))) {
    const main = JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8')).main ?? '';
    if (/\.tsx?$/.test(main)) applied.push('ts-loader');
    const src = join(kit, 'src');
    const monorepoImport = existsSync(src) && readdirSync(src).some(f =>
      /\.tsx?$/.test(f) && /from '(\.\.\/){3}core\//.test(readFileSync(join(src, f), 'utf8')));
    if (monorepoImport) {
      const link = join(pkgDir, 'node_modules', 'core');
      if (!existsSync(link)) symlinkSync('../core', link);
      applied.push('core-symlink');
    }
  }
  return applied;
}

/** Installs the exact tarball into runtime/<hash>/ once; returns the package directory. */
export function ensureInstalled(release) {
  const dir = join(RUNTIME, release.packageHash.slice(0, 16));
  const pkgDir = join(dir, 'node_modules', 'visx-render');
  const stamp = join(dir, 'installed.json');
  if (existsSync(stamp) && readJson(stamp).packageHash === release.packageHash && existsSync(pkgDir)) return pkgDir;
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    name: 'xarts-chat-runtime', private: true, type: 'module',
    dependencies: { 'visx-render': `file:${release.tarball}`, react: REACT, 'react-dom': REACT },
  }, null, 2));
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], { cwd: tmp, stdio: 'pipe' });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw new ReleaseError('install_failed', `npm install of ${release.tarball} failed: ${String(e.stderr || e.message).slice(0, 800)}`);
  }
  const shims = applyShims(join(tmp, 'node_modules', 'visx-render'));
  writeFileSync(join(tmp, 'installed.json'), JSON.stringify({ packageHash: release.packageHash, shims, installedAt: new Date().toISOString() }, null, 2));
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return pkgDir;
}

/** Shims applied to an installed release (empty when the package is consumable as shipped). */
export function installedShims(release) {
  const stamp = join(RUNTIME, release.packageHash.slice(0, 16), 'installed.json');
  return existsSync(stamp) ? (readJson(stamp).shims ?? []) : [];
}

/** Public view of a release (no local paths). */
export const describeRelease = r => ({
  kind: r.kind, label: r.label, releaseId: r.releaseId, incidentId: r.incidentId,
  sourceSha: r.sourceSha, packageHash: r.packageHash, version: r.version,
  activatedAt: r.activatedAt, priorReleaseId: r.priorReleaseId, note: r.note ?? null,
  shims: installedShims(r).map(id => ({ id, reason: SHIMS[id] })),
});
