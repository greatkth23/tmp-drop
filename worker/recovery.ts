import type { AppContext, FileRow, PartRow } from './types';
import { partBytes } from '../shared/contracts';
import { canListParts, listParts } from './storage';
import { ApiError } from './errors';
export const PART_LEASE_MS = 15 * 60_000;

// A DB lease fences acknowledgements, not R2 writes. Never start a second write for an uncertain part.
export async function recoverPart(
  c: AppContext,
  file: FileRow,
  n: number,
): Promise<PartRow | null> {
  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE upload_parts SET state='UNCERTAIN' WHERE file_id=? AND part_number=? AND state='SENDING' AND coalesce(lease_until,updated_at+?)<=?",
  )
    .bind(file.id, n, PART_LEASE_MS, now)
    .run();
  let part = await c.env.DB.prepare('SELECT * FROM upload_parts WHERE file_id=? AND part_number=?')
    .bind(file.id, n)
    .first<PartRow>();
  if (
    !part ||
    part.state !== 'UNCERTAIN' ||
    !canListParts(c.env) ||
    !file.multipart_id ||
    file.state !== 'UPLOADING'
  )
    return part;
  const token = crypto.randomUUID();
  const locked = await c.env.DB.prepare(
    "UPDATE upload_parts SET reconcile_token=?,reconcile_lease_until=? WHERE file_id=? AND part_number=? AND state='UNCERTAIN' AND coalesce(reconcile_lease_until,0)<=? RETURNING attempt_id",
  )
    .bind(token, now + 30_000, file.id, n, now)
    .first<{ attempt_id: string }>();
  if (!locked) return part;
  try {
    const result = await listParts(c.env, file.final_key, file.multipart_id, n - 1, 1);
    const stored = result.parts.find((p) => p.partNumber === n);
    if (stored) {
      if (stored.bytes !== partBytes(file.size_bytes, n))
        throw new ApiError(
          422,
          'PART_SIZE_MISMATCH',
          '저장소의 파일 부분 크기가 일치하지 않습니다.',
        );
      await c.env.DB.prepare(
        "UPDATE upload_parts SET state='DONE',etag=?,bytes=?,updated_at=?,reconcile_token=NULL,reconcile_lease_until=NULL WHERE file_id=? AND part_number=? AND attempt_id=? AND state='UNCERTAIN' AND reconcile_token=? AND EXISTS(SELECT 1 FROM files WHERE id=? AND state='UPLOADING')",
      )
        .bind(stored.etag, stored.bytes, Date.now(), file.id, n, locked.attempt_id, token, file.id)
        .run();
    }
  } catch (error) {
    if (
      error instanceof ApiError &&
      ['MULTIPART_MISSING', 'PART_SIZE_MISMATCH'].includes(error.code)
    ) {
      await c.env.DB.prepare(
        "UPDATE files SET state='FAILED',last_error_code=? WHERE id=? AND state='UPLOADING'",
      )
        .bind(error.code, file.id)
        .run();
      throw error;
    }
    // Transient errors and missing credentials leave the upload pending, without overwriting R2.
    console.log(
      JSON.stringify({
        event: 'part_recovery_pending',
        fileId: file.id,
        partNumber: n,
        code: error instanceof ApiError ? error.code : 'STORAGE_LOOKUP_FAILED',
      }),
    );
  } finally {
    // Back off failed lookups; a matching acknowledgement can still finish the original attempt.
    await c.env.DB.prepare(
      'UPDATE upload_parts SET reconcile_token=NULL,reconcile_lease_until=? WHERE file_id=? AND part_number=? AND reconcile_token=?',
    )
      .bind(Date.now() + 5_000, file.id, n, token)
      .run();
  }
  part = await c.env.DB.prepare('SELECT * FROM upload_parts WHERE file_id=? AND part_number=?')
    .bind(file.id, n)
    .first<PartRow>();
  return part;
}
export async function recoverFileParts(c: AppContext, file: FileRow, limit = 4): Promise<number> {
  const pending = (
    await c.env.DB.prepare(
      "SELECT part_number FROM upload_parts WHERE file_id=? AND (state='UNCERTAIN' OR (state='SENDING' AND coalesce(lease_until,updated_at+?)<=?)) ORDER BY coalesce(reconcile_lease_until,0),part_number LIMIT ?",
    )
      .bind(file.id, PART_LEASE_MS, Date.now(), limit)
      .all<{ part_number: number }>()
  ).results;
  let recovered = 0;
  for (const part of pending)
    if ((await recoverPart(c, file, part.part_number))?.state === 'DONE') recovered++;
  return recovered;
}
