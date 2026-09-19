// Portable registry wire contract v1. Vendored byte-for-byte by consumers; no project source dependency.
import { z } from 'zod';
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const fileId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const ActiveRelease = z.object({ schemaVersion: z.literal(1), releaseId: fileId, activatedAt: z.string().datetime() }).strict();
export const ReleaseEnvelope = z.object({
  schemaVersion: z.literal(1), id: fileId, incidentId: id, acceptedSha: sha, packageHash: hash,
  outputArtifactHash: hash, manifestHash: hash, gateResultIds: z.array(id).min(1),
  priorReleaseId: fileId.nullable(), destination: z.literal('local_demo_registry'), activatedAt: z.string().datetime(),
  package: z.object({ name: z.literal('visx-render'), version: z.string().min(1) }).strict().optional(),
}).strict();
