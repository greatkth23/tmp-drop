import { archiveFilename } from '../shared/file-labels';
import { Hono } from 'hono';
import type { AppContext, AppEnv, FileRow } from './types';
import { fileSelectionSchema, disposition } from '../shared/contracts';
import { browserPrincipal, downloadSession, grant } from './auth';
import { json, requireBrowserMutation } from './http';
import { hash, randomToken } from './crypto';
import { fail } from './errors';
import { summary } from './uploads';
import { deleteStoredFile } from './cleanup';
import { archiveStream } from './archive';

export const fileActions = new Hono<AppEnv>();
export const selectionTarget = (ids: string[]) => hash(JSON.stringify([...new Set(ids)].sort()));
async function readyFiles(c: AppContext, ids: string[]) {
  const rows = (
    await c.env.DB.prepare(
      "SELECT * FROM files WHERE id IN (SELECT value FROM json_each(?)) AND state='READY' AND expires_at>?",
    )
      .bind(JSON.stringify(ids), Date.now())
      .all<FileRow>()
  ).results;
  if (rows.length !== ids.length)
    fail(
      409,
      'SELECTION_UNAVAILABLE',
      '선택한 파일 중 만료되거나 삭제된 파일이 있습니다. 목록을 새로고침해 주세요.',
    );
  return rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}
fileActions.get('/api/file-groups', async (c) => {
  await downloadSession(c);
  let time = Number.MAX_SAFE_INTEGER,
    key = '~';
  if (c.req.query('cursor')) {
    try {
      const v = JSON.parse(atob(c.req.query('cursor')!));
      if (!Number.isSafeInteger(v.t) || typeof v.id !== 'string' || v.id.length > 64) throw Error();
      time = v.t;
      key = v.id;
    } catch {
      fail(400, 'INVALID_CURSOR', '목록 페이지를 확인할 수 없습니다.');
    }
  }
  const groups = (
    await c.env.DB.prepare(
      "SELECT coalesce(batch_id,id) AS id,max(completed_at) AS t FROM files WHERE state='READY' AND expires_at>? GROUP BY coalesce(batch_id,id) HAVING t<? OR (t=? AND coalesce(batch_id,id)<?) ORDER BY t DESC,id DESC LIMIT 26",
    )
      .bind(Date.now(), time, time, key)
      .all<{ id: string; t: number }>()
  ).results;
  const shown = groups.slice(0, 25),
    last = shown.at(-1);
  const rows = shown.length
    ? (
        await c.env.DB.prepare(
          "SELECT * FROM files WHERE state='READY' AND expires_at>? AND coalesce(batch_id,id) IN (SELECT value FROM json_each(?)) ORDER BY completed_at DESC,id DESC",
        )
          .bind(Date.now(), JSON.stringify(shown.map((g) => g.id)))
          .all<FileRow>()
      ).results
    : [];
  return c.json({
    files: rows.map(summary),
    nextCursor: groups.length > 25 && last ? btoa(JSON.stringify(last)) : null,
    serverNow: Date.now(),
  });
});
fileActions.post('/api/files/archive', async (c) => {
  await requireBrowserMutation(c);
  const session = (await downloadSession(c))!;
  const { ids } = await json(c, fileSelectionSchema);
  await readyFiles(c, ids);
  const token = randomToken(),
    expires = Math.min(Date.now() + 300_000, session.expires_at);
  await c.env.DB.prepare(
    'INSERT INTO download_archives(token_hash,session_id,file_ids,expires_at) VALUES(?,?,?,?)',
  )
    .bind(await hash(token), session.id, JSON.stringify(ids), expires)
    .run();
  return c.json({ url: `/api/archives/${token}`, expiresAt: expires });
});
fileActions.get('/api/archives/:token', async (c) => {
  const session = (await downloadSession(c))!;
  const ticket = await c.env.DB.prepare(
    'SELECT file_ids FROM download_archives WHERE token_hash=? AND session_id=? AND expires_at>?',
  )
    .bind(await hash(c.req.param('token')), session.id, Date.now())
    .first<{ file_ids: string }>();
  if (!ticket)
    fail(404, 'ARCHIVE_EXPIRED', '다운로드 준비 시간이 지났습니다. 파일을 다시 선택해 주세요.');
  const files = await readyFiles(c, JSON.parse(ticket.file_ids));
  for (const file of files) {
    const head = await c.env.BUCKET.head(file.final_key);
    if (!head || head.size !== file.size_bytes)
      fail(409, 'FILE_UNAVAILABLE', '선택한 파일을 확인할 수 없습니다. 목록을 새로고침해 주세요.');
  }
  return new Response(archiveStream(c.env.BUCKET, files), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': disposition(
        archiveFilename(
          files.map((f) => ({ id: f.id, filename: f.filename, completedAt: f.completed_at! })),
        ),
      ),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
fileActions.post('/api/files/delete', async (c) => {
  await requireBrowserMutation(c);
  await downloadSession(c);
  const { ids } = await json(c, fileSelectionSchema),
    principal = await browserPrincipal(c, false);
  if (principal?.kind !== 'device') await grant(c, 'delete_files', await selectionTarget(ids));
  const results: { id: string; state: string; message?: string }[] = [];
  for (const id of ids) {
    const file = await c.env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first<FileRow>();
    if (!file || file.state === 'DELETED') {
      results.push({ id, state: 'DELETED' });
      continue;
    }
    if (!['READY', 'EXPIRED', 'DELETING'].includes(file.state)) {
      results.push({ id, state: 'FAILED', message: '완료된 파일만 삭제할 수 있습니다.' });
      continue;
    }
    try {
      const result = await deleteStoredFile(c, file);
      results.push({
        id,
        state: result === 'deleted' ? 'DELETED' : result === 'failed' ? 'PENDING' : 'FAILED',
        ...(result !== 'deleted'
          ? {
              message:
                result === 'failed'
                  ? '목록에서 숨겼으며 저장소 정리를 다시 시도합니다.'
                  : '다른 삭제 작업이 진행 중입니다.',
            }
          : {}),
      });
    } catch {
      results.push({
        id,
        state: 'FAILED',
        message: '삭제 결과를 확인하지 못했습니다. 목록을 새로고침해 주세요.',
      });
    }
  }
  await c.env.DB.prepare(
    'INSERT INTO audit_events(id,event_type,resource_id,result,created_at,request_id) VALUES(?,?,?,?,?,?)',
  )
    .bind(
      crypto.randomUUID(),
      'files_deleted',
      await selectionTarget(ids),
      JSON.stringify(results.map((r) => ({ id: r.id, state: r.state }))),
      Date.now(),
      c.get('requestId'),
    )
    .run();
  return c.json({ results });
});
