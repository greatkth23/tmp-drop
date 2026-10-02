import type { AppContext } from './types';
import { ApiError } from './errors';
export type ReconcileMode = 'report' | 'repair_quota' | 'delete_orphans';
const DAY = 86_400_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const OWN_KEY = new RegExp(`^(final/${UUID}|staging/${UUID}/${UUID})$`);
interface QuotaSnapshot {
  reserved: number;
  ready: number;
  expectedReserved: number;
  expectedReady: number;
}
export async function quotaSnapshot(c: AppContext): Promise<QuotaSnapshot> {
  const row = await c.env.DB.prepare(
    "SELECT reserved_bytes AS reserved,ready_bytes AS ready,coalesce((SELECT sum(size_bytes) FROM files WHERE quota_bucket='reserved'),0) AS expectedReserved,coalesce((SELECT sum(size_bytes) FROM files WHERE quota_bucket='ready'),0) AS expectedReady FROM quota_state WHERE id=1",
  ).first<QuotaSnapshot>();
  if (!row) throw new ApiError(503, 'QUOTA_STATE_MISSING', '용량 기록을 확인할 수 없습니다.');
  return row;
}
function fingerprint(o: R2Object): string {
  return JSON.stringify([o.version, o.etag, o.size, o.uploaded.toISOString()]);
}
export async function reconcile(c: AppContext, mode: ReconcileMode = 'report', now = Date.now()) {
  const token = crypto.randomUUID();
  const locked = await c.env.DB.prepare(
    "INSERT INTO reconciliation_state(id,lease_token,lease_until,updated_at) VALUES('global',?,?,?) ON CONFLICT(id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at WHERE coalesce(reconciliation_state.lease_until,0)<=? RETURNING id",
  )
    .bind(token, now + 300_000, now, now)
    .first();
  if (!locked)
    throw new ApiError(
      409,
      'MAINTENANCE_IN_PROGRESS',
      '정합성 검사가 이미 진행 중입니다.',
      true,
      30,
    );
  try {
    const before = await quotaSnapshot(c);
    if (mode === 'repair_quota') {
      // The two SUMs and UPDATE execute as one SQLite write statement, serialized with admission triggers.
      await c.env.DB.prepare(
        "UPDATE quota_state SET reserved_bytes=coalesce((SELECT sum(size_bytes) FROM files WHERE quota_bucket='reserved'),0),ready_bytes=coalesce((SELECT sum(size_bytes) FROM files WHERE quota_bucket='ready'),0) WHERE id=1",
      ).run();
    }
    const report = {
      id: crypto.randomUUID(),
      mode,
      createdAt: now,
      quotaBefore: before,
      quotaAfter: await quotaSnapshot(c),
      scanned: 0,
      candidates: 0,
      eligible: 0,
      deleted: 0,
      unknownKeys: 0,
      missingReadyObjects: [] as string[],
      sizeMismatches: [] as string[],
      pages: [] as { prefix: string; hasMore: boolean }[],
    };
    for (const prefix of ['final/', 'staging/']) {
      const saved = await c.env.DB.prepare('SELECT cursor FROM reconciliation_state WHERE id=?')
        .bind(prefix)
        .first<{ cursor: string | null }>();
      const page = await c.env.BUCKET.list({
        prefix,
        cursor: saved?.cursor || undefined,
        limit: 10,
      });
      report.pages.push({ prefix, hasMore: page.truncated });
      const keys = page.objects.map((o) => o.key);
      const referenced = keys.length
        ? (
            await c.env.DB.prepare(
              `SELECT final_key,staging_key FROM files WHERE final_key IN (${keys.map(() => '?').join(',')}) OR staging_key IN (${keys.map(() => '?').join(',')})`,
            )
              .bind(...keys, ...keys)
              .all<{ final_key: string; staging_key: string | null }>()
          ).results
        : [];
      const protectedKeys = new Set(referenced.flatMap((r) => [r.final_key, r.staging_key]));
      for (const object of page.objects) {
        report.scanned++;
        if (!OWN_KEY.test(object.key)) {
          report.unknownKeys++;
          continue;
        }
        if (protectedKeys.has(object.key) || object.uploaded.getTime() > now - DAY) {
          await c.env.DB.prepare('DELETE FROM orphan_candidates WHERE object_key=?')
            .bind(object.key)
            .run();
          continue;
        }
        const fp = fingerprint(object);
        const candidate = await c.env.DB.prepare(
          `INSERT INTO orphan_candidates(object_key,fingerprint,first_seen_at,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(object_key) DO UPDATE SET fingerprint=excluded.fingerprint,first_seen_at=CASE WHEN orphan_candidates.fingerprint=excluded.fingerprint THEN orphan_candidates.first_seen_at ELSE excluded.first_seen_at END,last_seen_at=excluded.last_seen_at,sightings=CASE WHEN orphan_candidates.fingerprint=excluded.fingerprint THEN orphan_candidates.sightings+1 ELSE 1 END RETURNING first_seen_at,sightings`,
        )
          .bind(object.key, fp, now, now)
          .first<{ first_seen_at: number; sightings: number }>();
        report.candidates++;
        if (!candidate || candidate.first_seen_at > now - DAY || candidate.sightings < 2) continue;
        report.eligible++;
        if (mode !== 'delete_orphans' || report.deleted >= 3) continue;
        const head = await c.env.BUCKET.head(object.key);
        if (!head || fingerprint(head) !== fp) continue;
        // Recheck D1 immediately before deleting. Any database error stops the entire run.
        const safe = await c.env.DB.prepare(
          "SELECT id FROM reconciliation_state WHERE id='global' AND lease_token=? AND lease_until>? AND NOT EXISTS(SELECT 1 FROM files WHERE final_key=? OR staging_key=?)",
        )
          .bind(token, Date.now(), object.key, object.key)
          .first();
        if (!safe) continue;
        await c.env.BUCKET.delete(object.key);
        await c.env.DB.prepare('DELETE FROM orphan_candidates WHERE object_key=?')
          .bind(object.key)
          .run();
        report.deleted++;
      }
      await c.env.DB.prepare(
        'INSERT INTO reconciliation_state(id,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at',
      )
        .bind(prefix, page.truncated ? page.cursor : null, now)
        .run();
    }
    const ready = (
      await c.env.DB.prepare(
        "SELECT id,final_key,size_bytes FROM files WHERE state='READY' AND expires_at>? ORDER BY coalesce(object_checked_at,0),id LIMIT 5",
      )
        .bind(now)
        .all<{ id: string; final_key: string; size_bytes: number }>()
    ).results;
    for (const file of ready) {
      const head = await c.env.BUCKET.head(file.final_key);
      if (!head) report.missingReadyObjects.push(file.id);
      else if (
        head.size !== file.size_bytes ||
        (head.customMetadata?.fileId || head.customMetadata?.fileid) !== file.id
      )
        report.sizeMismatches.push(file.id);
      await c.env.DB.prepare('UPDATE files SET object_checked_at=? WHERE id=?')
        .bind(now, file.id)
        .run();
    }
    await c.env.DB.prepare(
      'INSERT INTO reconciliation_reports(id,mode,created_at,report_json) VALUES(?,?,?,?)',
    )
      .bind(report.id, mode, now, JSON.stringify(report))
      .run();
    return report;
  } finally {
    await c.env.DB.prepare(
      "UPDATE reconciliation_state SET lease_token=NULL,lease_until=NULL WHERE id='global' AND lease_token=?",
    )
      .bind(token)
      .run();
  }
}
