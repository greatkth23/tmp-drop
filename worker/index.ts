import { Hono } from 'hono';
import { fileActions, selectionTarget } from './file-actions';
import { z } from 'zod';
import type { AppContext, AppEnv, FileRow } from './types';
import { POLICY, pinSchema, totpSchema } from '../shared/contracts';
import { ApiError, errorResponse, fail } from './errors';
import { hash, randomToken, safeEqual } from './crypto';
import {
  cookie,
  clearCookie,
  writeCookie,
  csrfToken,
  requireBrowserMutation,
  json,
  isLocal,
} from './http';
import {
  browserPrincipal,
  shortcutPrincipal,
  downloadSession,
  limitAuth,
  consumeTotp,
  verifyPin,
  grant,
  uploadCapability,
} from './auth';
import {
  createUpload,
  partUpload,
  completeUpload,
  cancelFile,
  uploadStatus,
  localShortcutBody,
  summary,
} from './uploads';
import { presign } from './storage';
import { cleanup, deleteStoredFile } from './cleanup';
import { reconcile } from './reconciliation';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  if (
    c.env.ENVIRONMENT === 'staging' &&
    (!c.env.STAGING_GATE_SECRET ||
      !safeEqual(c.req.header('X-Staging-Token') || '', c.env.STAGING_GATE_SECRET))
  )
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  await next();
});
app.use('/api/*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Request-Id', c.get('requestId'));
  if (c.env.ENVIRONMENT === 'local' && !isLocal(c))
    fail(503, 'LOCAL_ONLY', '로컬 개발 설정은 외부 주소에서 실행할 수 없습니다.');
  await next();
});
app.onError(errorResponse);
async function audit(c: AppContext, event: string, resource?: string): Promise<void> {
  await c.env.DB.prepare(
    'INSERT INTO audit_events(id,event_type,resource_id,result,created_at,request_id) VALUES(?,?,?,?,?,?)',
  )
    .bind(crypto.randomUUID(), event, resource || null, 'success', Date.now(), c.get('requestId'))
    .run();
}
app.route('/', fileActions);
app.get('/api/health', (c) => c.json({ ok: true, version: '0.2.0' }));
app.get('/api/auth/status', async (c) => {
  const [p, d] = await Promise.all([browserPrincipal(c, false), downloadSession(c, false)]);
  return c.json({
    uploadAuth: p ? (p.kind === 'device' ? 'trusted' : 'temporary') : 'none',
    uploadExpiresAt: p?.expiresAt || null,
    deviceName: p?.name || null,
    downloadUnlocked: !!d,
    downloadExpiresAt: d?.expires_at || null,
    csrfToken: await csrfToken(c),
    serverNow: Date.now(),
    local: isLocal(c),
    limits: { webMax: POLICY.webMax, partSize: POLICY.partSize },
  });
});
app.post('/api/auth/totp', async (c) => {
  await requireBrowserMutation(c);
  await limitAuth(c, 'totp');
  const input = await json(c, totpSchema);
  if (input.intent === 'trust' && !input.deviceName)
    fail(400, 'DEVICE_NAME_REQUIRED', '기기 이름을 입력해 주세요.');
  if (['revoke_device', 'delete_file'].includes(input.intent) && !input.targetId)
    fail(400, 'TARGET_REQUIRED', '작업 대상이 필요합니다.');
  if (input.intent === 'delete_files' && !input.targetIds?.length)
    fail(400, 'TARGET_REQUIRED', '삭제할 파일을 선택해 주세요.');
  const target =
    input.intent === 'delete_files'
      ? await selectionTarget(input.targetIds!)
      : input.targetId || null;
  await consumeTotp(c, input.code);
  const token = randomToken(),
    id = crypto.randomUUID(),
    now = Date.now();
  if (input.intent === 'trust') {
    await c.env.DB.prepare(
      "INSERT INTO trusted_devices(id,name,kind,token_hash,created_at,last_used_at) VALUES(?,?,'browser',?,?,?)",
    )
      .bind(id, input.deviceName!, await hash(token), now, now)
      .run();
    writeCookie(c, 'td', token, 365 * 86400);
    clearCookie(c, 'ps');
    await audit(c, 'device_registered', id);
    return c.json({ authenticated: true });
  }
  if (input.intent === 'upload') {
    await c.env.DB.prepare(
      'INSERT INTO temp_sessions(id,token_hash,created_at,expires_at) VALUES(?,?,?,?)',
    )
      .bind(id, await hash(token), now, now + POLICY.tempTtl)
      .run();
    writeCookie(c, 'ps', token, 900);
    await audit(c, 'temporary_session_created', id);
    return c.json({ authenticated: true, expiresAt: now + POLICY.tempTtl });
  }
  await c.env.DB.prepare(
    'INSERT INTO admin_grants(id,token_hash,purpose,target_id,expires_at) VALUES(?,?,?,?,?)',
  )
    .bind(id, await hash(token), input.intent, target, now + POLICY.grantTtl)
    .run();
  return c.json({ grant: token, expiresAt: now + POLICY.grantTtl });
});
app.post('/api/download/unlock', async (c) => {
  await requireBrowserMutation(c);
  await limitAuth(c, 'pin');
  const input = await json(c, pinSchema);
  await verifyPin(c, input.pin);
  const token = randomToken(),
    now = Date.now(),
    ttl = input.remember ? POLICY.rememberTtl : POLICY.downloadTtl;
  await c.env.DB.prepare(
    'INSERT INTO download_sessions(id,token_hash,pin_version,created_at,expires_at) VALUES(?,?,?,?,?)',
  )
    .bind(crypto.randomUUID(), await hash(token), c.env.PIN_VERSION, now, now + ttl)
    .run();
  writeCookie(c, 'da', token, input.remember ? ttl / 1000 : undefined);
  await audit(c, 'download_unlocked');
  return c.json({ unlocked: true });
});
app.post('/api/auth/logout', async (c) => {
  await requireBrowserMutation(c);
  const input = await json(
    c,
    z.object({
      scope: z.enum(['upload', 'download', 'all']),
      activeUploads: z
        .array(z.object({ id: z.string().uuid(), capability: z.string().length(43) }))
        .max(50)
        .default([]),
    }),
  );
  if (input.scope !== 'download') {
    const authorized: FileRow[] = [];
    for (const item of input.activeUploads) {
      try {
        authorized.push(await uploadCapability(c, item.id, item.capability));
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !['CAPABILITY_EXPIRED', 'DEVICE_REVOKED'].includes(error.code)
        )
          throw error;
      }
    }
    const session = cookie(c, 'ps');
    if (session)
      await c.env.DB.prepare(
        'UPDATE temp_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL',
      )
        .bind(Date.now(), await hash(session))
        .run();
    for (const file of authorized) {
      if (['CREATING', 'UPLOADING', 'FAILED'].includes(file.state)) await cancelFile(c, file);
    }
    clearCookie(c, 'ps');
  }
  if (input.scope !== 'upload') {
    const token = cookie(c, 'da');
    if (token)
      await c.env.DB.prepare('UPDATE download_sessions SET revoked_at=? WHERE token_hash=?')
        .bind(Date.now(), await hash(token))
        .run();
    clearCookie(c, 'da');
  }
  return c.json({ loggedOut: true });
});
app.get('/api/devices', async (c) => {
  const p = await browserPrincipal(c, false);
  if (p?.kind !== 'device') await grant(c, 'manage');
  const rows = (
    await c.env.DB.prepare(
      'SELECT id,name,kind,created_at,last_used_at FROM trusted_devices WHERE revoked_at IS NULL ORDER BY created_at DESC',
    ).all<{ id: string; name: string; kind: string; created_at: number; last_used_at: number }>()
  ).results;
  return c.json({
    devices: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      current: r.id === p?.id,
    })),
  });
});
app.post('/api/devices', async (c) => {
  await requireBrowserMutation(c);
  const input = await json(
    c,
    z.object({ name: z.string().trim().min(1).max(50), kind: z.literal('shortcut') }),
  );
  await grant(c, 'create_device');
  const token = randomToken(),
    id = crypto.randomUUID(),
    now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO trusted_devices(id,name,kind,token_hash,created_at,last_used_at) VALUES(?,?,'shortcut',?,?,?)",
  )
    .bind(id, input.name, await hash(token), now, now)
    .run();
  await audit(c, 'shortcut_device_created', id);
  return c.json({ id, token }, 201);
});
app.delete('/api/devices/:id', async (c) => {
  await requireBrowserMutation(c);
  const id = c.req.param('id');
  await grant(c, 'revoke_device', id);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE trusted_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
    ).bind(now, id),
    c.env.DB.prepare(
      "UPDATE files SET state='CANCEL_REQUESTED',cancel_requested_at=? WHERE owner_device_id=? AND state IN('CREATING','UPLOADING')",
    ).bind(now, id),
  ]);
  await audit(c, 'device_revoked', id);
  return c.json({ revokedAt: now });
});
app.post('/api/uploads', async (c) => {
  await requireBrowserMutation(c);
  return createUpload(c, (await browserPrincipal(c))!);
});
app.post('/api/shortcut/uploads', async (c) => createUpload(c, await shortcutPrincipal(c), true));
app.get('/api/uploads/:id', uploadStatus);
app.put('/api/uploads/:id/parts/:n', partUpload);
app.put('/api/uploads/:id/shortcut-body', localShortcutBody);
app.post('/api/uploads/:id/complete', completeUpload);
app.delete('/api/uploads/:id', async (c) => {
  await cancelFile(c, await uploadCapability(c, c.req.param('id')));
  return c.json({ state: 'CANCEL_REQUESTED' }, 202);
});
app.get('/api/files', async (c) => {
  await downloadSession(c);
  const limit = Math.min(50, Math.max(1, Math.floor(Number(c.req.query('limit')) || 25)));
  let time = Number.MAX_SAFE_INTEGER,
    id = '~';
  const cursor = c.req.query('cursor');
  if (cursor) {
    try {
      const value = JSON.parse(atob(cursor));
      if (!Number.isSafeInteger(value.t) || typeof value.id !== 'string' || value.id.length > 50)
        throw Error();
      time = value.t;
      id = value.id;
    } catch {
      fail(400, 'INVALID_CURSOR', '목록 페이지를 확인할 수 없습니다.');
    }
  }
  const rows = (
    await c.env.DB.prepare(
      "SELECT * FROM files WHERE state='READY' AND expires_at>? AND (completed_at<? OR (completed_at=? AND id<?)) ORDER BY completed_at DESC,id DESC LIMIT ?",
    )
      .bind(Date.now(), time, time, id, limit + 1)
      .all<FileRow>()
  ).results;
  const visible = rows.slice(0, limit),
    last = visible.at(-1);
  return c.json({
    files: visible.map(summary),
    nextCursor:
      rows.length > limit && last
        ? btoa(JSON.stringify({ t: last.completed_at, id: last.id }))
        : null,
    serverNow: Date.now(),
  });
});
app.delete('/api/files/:id', async (c) => {
  await requireBrowserMutation(c);
  await downloadSession(c);
  const id = c.req.param('id');
  const principal = await browserPrincipal(c, false);
  if (principal?.kind !== 'device') await grant(c, 'delete_file', id);
  const file = await c.env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first<FileRow>();
  if (!file) fail(404, 'FILE_UNAVAILABLE', '파일을 찾을 수 없습니다.');
  if (file.state === 'DELETED') return c.json({ state: 'DELETED' });
  if (!['READY', 'EXPIRED', 'DELETING'].includes(file.state))
    fail(409, 'FILE_NOT_READY', '완료된 파일만 삭제할 수 있습니다.');
  const result = await deleteStoredFile(c, file);
  if (result === 'busy')
    fail(409, 'DELETE_IN_PROGRESS', '이미 삭제 중입니다. 잠시 후 목록을 새로고침해 주세요.');
  if (result === 'failed')
    fail(
      503,
      'DELETE_FAILED',
      '파일을 목록에서 숨겼지만 저장소 정리가 지연되고 있습니다. 자동으로 다시 시도합니다.',
    );
  await audit(c, 'file_deleted', id);
  return c.json({ state: 'DELETED' });
});
app.get('/api/files/:id/download', async (c) => {
  const d = (await downloadSession(c))!;
  const file = await c.env.DB.prepare(
    "SELECT * FROM files WHERE id=? AND state='READY' AND expires_at>?",
  )
    .bind(c.req.param('id'), Date.now())
    .first<FileRow>();
  if (!file) fail(404, 'FILE_UNAVAILABLE', '파일이 없거나 보관 시간이 끝났습니다.');
  const ttl = Math.floor(
    Math.min(300_000, file.expires_at! - Date.now(), d.expires_at - Date.now()) / 1000,
  );
  if (ttl < 1) fail(404, 'FILE_UNAVAILABLE', '파일의 보관 시간이 끝났습니다.');
  if (isLocal(c)) {
    const object = await c.env.BUCKET.get(file.final_key, { range: c.req.raw.headers });
    if (!object || !('body' in object)) fail(404, 'FILE_UNAVAILABLE', '파일을 찾을 수 없습니다.');
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('ETag', object.httpEtag);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    const ranged = c.req.raw.headers.has('Range') && !!object.range;
    if (ranged) {
      const r = object.range!;
      if ('offset' in r && 'length' in r) {
        headers.set(
          'Content-Range',
          `bytes ${r.offset}-${r.offset! + r.length! - 1}/${object.size}`,
        );
        headers.set('Content-Length', String(r.length));
      }
    } else headers.set('Content-Length', String(object.size));
    return new Response(object.body, { status: ranged ? 206 : 200, headers });
  }
  return c.redirect(await presign(c.env, file.final_key, 'GET', ttl), 302);
});
app.post('/api/local/cleanup', async (c) => {
  if (!isLocal(c)) fail(404, 'NOT_FOUND', '요청을 찾을 수 없습니다.');
  await requireBrowserMutation(c);
  await browserPrincipal(c);
  return c.json(await cleanup(c));
});
app.post('/api/maintenance/reconcile', async (c) => {
  await requireBrowserMutation(c);
  const input = await json(
    c,
    z.object({ mode: z.enum(['report', 'repair_quota', 'delete_orphans']) }).strict(),
  );
  await grant(
    c,
    input.mode === 'report'
      ? 'maintenance_report'
      : input.mode === 'repair_quota'
        ? 'maintenance_quota'
        : 'maintenance_delete',
  );
  const report = await reconcile(c, input.mode);
  await audit(c, 'maintenance_' + input.mode, report.id);
  return c.json(report);
});
app.all('/api/*', (c) =>
  c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: '요청을 찾을 수 없습니다.',
        requestId: c.get('requestId'),
        retryable: false,
      },
    },
    404,
  ),
);
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
export { app };
export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    const request = new Request(env.APP_ORIGIN + '/api/internal/cleanup');
    // Reuse the cleanup service without exposing a production HTTP maintenance endpoint.
    const context = new (await import('hono')).Context<AppEnv>(request, { env, executionCtx: ctx });
    context.set('requestId', crypto.randomUUID());
    const result = await cleanup(context);
    console.log(JSON.stringify({ event: 'cleanup', ...result }));
    try {
      const report = await reconcile(context);
      console.log(
        JSON.stringify({
          event: 'reconciliation',
          id: report.id,
          scanned: report.scanned,
          candidates: report.candidates,
          missingReady: report.missingReadyObjects.length,
          quotaMismatch:
            report.quotaAfter.reserved !== report.quotaAfter.expectedReserved ||
            report.quotaAfter.ready !== report.quotaAfter.expectedReady,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          event: 'reconciliation_failed',
          code: error instanceof ApiError ? error.code : 'MAINTENANCE_FAILED',
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
