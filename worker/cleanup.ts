import type { AppContext, FileRow } from './types';
import { POLICY } from '../shared/contracts';
import { recoverFinalization } from './uploads';
import { recoverFileParts, PART_LEASE_MS } from './recovery';
// Persist removal before acknowledging it. Cron recovers DELETING rows even if
// waitUntil is interrupted, and the existing deletion lease prevents double work.
export async function enqueueDeletion(c: AppContext, file: FileRow) {
  const claimed = await c.env.DB.prepare(
    "UPDATE files SET state='DELETING' WHERE id=? AND state IN('READY','EXPIRED','DELETING') RETURNING id",
  )
    .bind(file.id)
    .first();
  if (!claimed) return false;
  c.executionCtx.waitUntil(
    deleteStoredFile(c, file).catch(() => {
      // The durable DELETING row remains eligible for scheduled cleanup.
    }),
  );
  return true;
}
// Share the lease and retry path between immediate deletion and scheduled cleanup.
export async function deleteStoredFile(
  c: AppContext,
  file: FileRow,
): Promise<'deleted' | 'busy' | 'failed'> {
  const now = Date.now();
  const leased = await c.env.DB.prepare(
    `INSERT INTO maintenance_jobs(id,resource_id,type,run_after,lease_until) VALUES(?,?,'delete',?,?)
    ON CONFLICT(resource_id) DO UPDATE SET lease_until=excluded.lease_until WHERE maintenance_jobs.lease_until IS NULL OR maintenance_jobs.lease_until<=? RETURNING id`,
  )
    .bind(crypto.randomUUID(), file.id, now, now + 300_000, now)
    .first();
  if (!leased) return 'busy';
  try {
    const claimed = await c.env.DB.prepare(
      "UPDATE files SET state='DELETING' WHERE id=? AND state IN('READY','FAILED','CANCEL_REQUESTED','CANCELLED','EXPIRED','DELETING') RETURNING id",
    )
      .bind(file.id)
      .first();
    if (!claimed) {
      await c.env.DB.prepare('DELETE FROM maintenance_jobs WHERE resource_id=?')
        .bind(file.id)
        .run();
      return 'busy';
    }
    if (file.multipart_id) {
      try {
        await c.env.BUCKET.resumeMultipartUpload(file.final_key, file.multipart_id).abort();
      } catch (error) {
        if (!/NoSuchUpload|does not exist|not found/i.test(String(error))) throw error;
      }
    }
    await c.env.BUCKET.delete(
      file.staging_key ? [file.final_key, file.staging_key] : file.final_key,
    );
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE files SET state='DELETED',deleted_at=?,quota_bucket='released' WHERE id=? AND state='DELETING'",
      ).bind(Date.now(), file.id),
      c.env.DB.prepare('DELETE FROM maintenance_jobs WHERE resource_id=?').bind(file.id),
    ]);
    return 'deleted';
  } catch {
    await c.env.DB.prepare(
      "UPDATE maintenance_jobs SET attempts=attempts+1,run_after=?,lease_until=NULL,last_error_code='DELETE_FAILED' WHERE resource_id=?",
    )
      .bind(now + 900_000, file.id)
      .run();
    return 'failed';
  }
}
export async function cleanup(
  c: AppContext,
): Promise<{ deleted: number; recovered: number; failed: number }> {
  const now = Date.now();
  let deleted = 0,
    recovered = 0,
    failed = 0;
  await c.env.DB.prepare("UPDATE files SET state='EXPIRED' WHERE state='READY' AND expires_at<=?")
    .bind(now)
    .run();
  await c.env.DB.prepare(
    "UPDATE files SET state='FAILED',last_error_code='UPLOAD_EXPIRED' WHERE state IN('CREATING','UPLOADING') AND (capability_expires_at<=? OR (first_part_at IS NULL AND created_at<=?))",
  )
    .bind(now, now - POLICY.idleTtl)
    .run();
  const uncertain = (
    await c.env.DB.prepare(
      "SELECT * FROM files WHERE state='UPLOADING' AND EXISTS(SELECT 1 FROM upload_parts WHERE file_id=files.id AND (state='UNCERTAIN' OR (state='SENDING' AND coalesce(lease_until,updated_at+?)<=?))) ORDER BY last_activity_at LIMIT 3",
    )
      .bind(PART_LEASE_MS, now)
      .all<FileRow>()
  ).results;
  for (const file of uncertain) {
    try {
      recovered += await recoverFileParts(c, file, 2);
    } catch {
      failed++;
    }
  }
  const finishing = (
    await c.env.DB.prepare(
      "SELECT * FROM files WHERE state='FINALIZING' AND finalize_lease_until<=? LIMIT 3",
    )
      .bind(now)
      .all<FileRow>()
  ).results;
  for (const file of finishing) {
    try {
      const result = await recoverFinalization(c, file);
      if (result.state === 'READY') recovered++;
      else failed++;
    } catch {
      failed++;
    }
  }
  const pending = (
    await c.env.DB.prepare(
      "SELECT * FROM files WHERE state IN('FAILED','CANCEL_REQUESTED','CANCELLED','EXPIRED','DELETING') AND NOT EXISTS(SELECT 1 FROM maintenance_jobs WHERE resource_id=files.id AND run_after>?) ORDER BY created_at LIMIT 10",
    )
      .bind(now)
      .all<FileRow>()
  ).results;
  for (const file of pending) {
    const result = await deleteStoredFile(c, file);
    if (result === 'deleted') deleted++;
    if (result === 'failed') failed++;
  }

  // Replayed presigned PUTs can recreate staging objects, so retain their names and sweep again.
  const staging = (
    await c.env.DB.prepare(
      "SELECT id,staging_key FROM files WHERE staging_key IS NOT NULL AND state IN('READY','DELETED') AND created_at<? ORDER BY coalesce(staging_swept_at,0),created_at,id LIMIT 10",
    )
      .bind(now - 7200_000)
      .all<{ id: string; staging_key: string }>()
  ).results;
  if (staging.length) {
    await c.env.BUCKET.delete(staging.map((s) => s.staging_key));
    await c.env.DB.batch(
      staging.map((s) =>
        c.env.DB.prepare('UPDATE files SET staging_swept_at=? WHERE id=?').bind(now, s.id),
      ),
    );
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM download_archives WHERE expires_at<?').bind(now),
    c.env.DB.prepare('DELETE FROM auth_attempts WHERE attempted_at<?').bind(now - 600_000),
    c.env.DB.prepare('DELETE FROM totp_uses WHERE used_at<?').bind(now - 300_000),
    c.env.DB.prepare('DELETE FROM admin_grants WHERE expires_at<?').bind(now),
    c.env.DB.prepare(
      'UPDATE idempotency_keys SET response_ciphertext=NULL WHERE expires_at<? AND response_ciphertext IS NOT NULL',
    ).bind(now),
    c.env.DB.prepare('DELETE FROM download_sessions WHERE expires_at<?').bind(now),
    c.env.DB.prepare(
      'DELETE FROM temp_sessions WHERE expires_at<? AND NOT EXISTS(SELECT 1 FROM files WHERE owner_session_id=temp_sessions.id)',
    ).bind(now),
    c.env.DB.prepare('DELETE FROM audit_events WHERE created_at<?').bind(now - 30 * 86_400_000),
    c.env.DB.prepare('DELETE FROM reconciliation_reports WHERE created_at<?').bind(
      now - 30 * 86_400_000,
    ),
    c.env.DB.prepare("DELETE FROM daily_usage WHERE day_utc<date(?,'unixepoch')").bind(
      Math.floor((now - 30 * 86_400_000) / 1000),
    ),
    c.env.DB.prepare(
      "DELETE FROM idempotency_keys WHERE file_id IN(SELECT id FROM files WHERE state='DELETED' AND quota_bucket='released' AND deleted_at<? AND capability_expires_at<? AND NOT EXISTS(SELECT 1 FROM maintenance_jobs WHERE resource_id=files.id) ORDER BY deleted_at,id LIMIT 50)",
    ).bind(now - 30 * 86_400_000, now),
    c.env.DB.prepare(
      "DELETE FROM files WHERE id IN(SELECT id FROM files WHERE state='DELETED' AND quota_bucket='released' AND deleted_at<? AND capability_expires_at<? AND NOT EXISTS(SELECT 1 FROM maintenance_jobs WHERE resource_id=files.id) AND NOT EXISTS(SELECT 1 FROM idempotency_keys WHERE file_id=files.id) ORDER BY deleted_at,id LIMIT 50)",
    ).bind(now - 30 * 86_400_000, now),
  ]);
  return { deleted, recovered, failed };
}
