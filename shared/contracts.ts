import { z } from 'zod';
export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const POLICY = Object.freeze({
  tempTtl: 900_000,
  capabilityTtl: 6 * 3_600_000,
  partSize: 64 * MiB,
  webMax: 32 * GiB,
  shortcutMax: 5 * GiB,
  quota: 100 * GiB,
  daily: 200 * GiB,
  maxActive: 8,
  maxPerPrincipal: 4,
  idleTtl: 600_000,
  grantTtl: 300_000,
  downloadTtl: 7_200_000,
  rememberTtl: 30 * 86_400_000,
  retention: [3600, 21600, 86400, 259200],
});
export const uploadSchema = z
  .object({
    filename: z.string().min(1).max(1000),
    sizeBytes: z.number().int().positive().max(POLICY.webMax),
    mime: z.string().max(150).default('application/octet-stream'),
    retentionSeconds: z.number().refine((n) => POLICY.retention.includes(n)),
  })
  .strict();
export const totpSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/),
    intent: z.enum([
      'upload',
      'trust',
      'manage',
      'create_device',
      'revoke_device',
      'delete_file',
      'maintenance_report',
      'maintenance_quota',
      'maintenance_delete',
    ]),
    deviceName: z.string().trim().min(1).max(50).optional(),
    targetId: z.string().uuid().optional(),
  })
  .strict();
export const pinSchema = z
  .object({ pin: z.string().regex(/^\d{4}$/), remember: z.boolean().default(false) })
  .strict();
export type FileState =
  | 'CREATING'
  | 'UPLOADING'
  | 'FINALIZING'
  | 'READY'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'DELETING'
  | 'DELETED';
export interface AuthStatus {
  uploadAuth: 'none' | 'temporary' | 'trusted';
  uploadExpiresAt: number | null;
  deviceName: string | null;
  downloadUnlocked: boolean;
  downloadExpiresAt: number | null;
  csrfToken: string;
  serverNow: number;
  local: boolean;
  limits: { webMax: number; partSize: number };
}
export interface UploadCreated {
  id: string;
  state: FileState;
  capability: string;
  capabilityExpiresAt: number;
  partSizeBytes: number;
  partCount: number;
  serverNow: number;
  putUrl?: string;
  putHeaders?: Record<string, string>;
}
export interface FileSummary {
  id: string;
  filename: string;
  sizeBytes: number;
  completedAt: number;
  expiresAt: number;
}
export interface UploadStatus {
  id: string;
  state: FileState;
  completedParts: { partNumber: number; bytes: number }[];
  capabilityExpiresAt: number;
  result: FileSummary | null;
}
export interface DeviceSummary {
  id: string;
  name: string;
  kind: 'browser' | 'shortcut';
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
}
export function partBytes(size: number, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > Math.ceil(size / POLICY.partSize)) return 0;
  return Math.min(POLICY.partSize, size - (n - 1) * POLICY.partSize);
}
export function sanitizeFilename(input: string): string {
  const value = input
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim();
  if (!value || new TextEncoder().encode(value).length > 255) throw new Error('INVALID_FILENAME');
  return value;
}
export function disposition(name: string): string {
  const fallback = name.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
