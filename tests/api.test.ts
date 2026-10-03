import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import type { AppEnv, FileRow } from '../worker/types';
import { reconcile } from '../worker/reconciliation';
import { cancelFile } from '../worker/uploads';
import { decodeParts } from '../worker/storage';
import { TOTP } from 'otpauth';
import worker, { app } from '../worker/index';
import { pipeExact } from '../worker/storage';
import { hash } from '../worker/crypto';
import { selectionTarget } from '../worker/file-actions';
import { archiveNames } from '../worker/archive';
import { POLICY, sanitizeFilename, partBytes, disposition } from '../shared/contracts';
import type { AuthStatus, UploadCreated } from '../shared/contracts';

class Browser {
  runtime: Env = env;
  cookies = new Map<string, string>();
  csrf = '';
  async request(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
    const headers = new Headers({
      Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    });
    let data: BodyInit | undefined;
    if (body instanceof Uint8Array) {
      data = body;
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Length', String(body.byteLength));
    } else if (method !== 'GET') {
      headers.set('Origin', 'http://localhost:8787');
      headers.set('Content-Type', 'application/json');
      headers.set('X-CSRF-Token', this.csrf);
      data = JSON.stringify(body || {});
    }
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request('http://localhost:8787' + path, { method, headers, body: data }),
      this.runtime,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const index = pair.indexOf('=');
      const key = pair.slice(0, index),
        val = pair.slice(index + 1);
      if (val) this.cookies.set(key, val);
      else this.cookies.delete(key);
    }
    return response;
  }
  async status() {
    const res = await this.request('/api/auth/status');
    const value = await res.json<AuthStatus>();
    this.csrf = value.csrfToken;
    return value;
  }
  async login(trust = false) {
    await this.status();
    const code = new TOTP({ secret: env.TOTP_SECRET }).generate();
    const response = await this.request('/api/auth/totp', 'POST', {
      code,
      intent: trust ? 'trust' : 'upload',
      ...(trust ? { deviceName: 'Test browser' } : {}),
    });
    expect(response.status).toBe(200);
    await this.status();
  }
  async upload(size = 3) {
    const r = await this.request(
      '/api/uploads',
      'POST',
      { filename: '한글.zip', sizeBytes: size, mime: 'application/zip', retentionSeconds: 86400 },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(r.status).toBe(201);
    return r.json<UploadCreated>();
  }
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  const tables = [
    'download_archives',
    'idempotency_keys',
    'maintenance_jobs',
    'upload_parts',
    'files',
    'trusted_devices',
    'temp_sessions',
    'download_sessions',
    'admin_grants',
    'totp_uses',
    'auth_attempts',
    'daily_usage',
    'audit_events',
    'reconciliation_state',
    'reconciliation_reports',
    'orphan_candidates',
  ];
  await env.DB.batch([
    ...tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare('UPDATE quota_state SET reserved_bytes=0,ready_bytes=0'),
  ]);
  const objects = await env.BUCKET.list();
  if (objects.objects.length) await env.BUCKET.delete(objects.objects.map((o) => o.key));
});
afterEach(() => vi.restoreAllMocks());

function storageBrowser(b: Browser) {
  b.runtime = {
    ...env,
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET_NAME: 'test-bucket',
  };
}
function partsXml(
  file: { final_key: string; multipart_id: string },
  parts: { partNumber: number; etag: string; bytes: number }[],
  truncated = false,
  marker?: number,
) {
  return `<ListPartsResult><Key>${file.final_key}</Key><UploadId>${file.multipart_id}</UploadId><IsTruncated>${truncated}</IsTruncated>${marker === undefined ? '' : `<NextPartNumberMarker>${marker}</NextPartNumberMarker>`}${parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag><Size>${p.bytes}</Size></Part>`).join('')}</ListPartsResult>`;
}
function serviceContext() {
  return new Context<AppEnv>(new Request('http://localhost:8787/api/internal/test'), {
    env,
    executionCtx: createExecutionContext(),
  });
}

describe('upload batches and selected file actions', () => {
  async function start(trust = true) {
    const b = new Browser();
    await b.login(trust);
    expect((await b.request('/api/download/unlock', 'POST', { pin: '4827' })).status).toBe(200);
    await b.status();
    return b;
  }
  async function ready(
    b: Browser,
    batchKey?: string,
    filename = '사진.png',
    data: Uint8Array = new Uint8Array([1, 2, 3]),
  ) {
    const res = await b.request(
      '/api/uploads',
      'POST',
      {
        filename,
        sizeBytes: data.length,
        mime: 'application/octet-stream',
        retentionSeconds: 86400,
        ...(batchKey ? { batchKey } : {}),
      },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(res.status).toBe(201);
    const u = await res.json<UploadCreated>(),
      h = { Authorization: 'Upload ' + u.capability };
    expect((await b.request(`/api/uploads/${u.id}/parts/1`, 'PUT', data, h)).status).toBe(200);
    expect((await b.request(`/api/uploads/${u.id}/complete`, 'POST', {}, h)).status).toBe(200);
    return (await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(u.id).first<FileRow>())!;
  }
  it('serves sniffed raster previews only to an unlocked download session without caching', async () => {
    const b = await start();
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    const file = await ready(b, undefined, 'photo.png', png);
    const path = '/api/files/' + file.id + '/preview';
    expect((await new Browser().request(path)).status).toBe(401);
    const preview = await b.request(path);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Content-Type')).toBe('image/png');
    expect(preview.headers.get('Cache-Control')).toContain('no-store');
    expect(preview.headers.get('Content-Disposition')).toBe('inline');
    expect(preview.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(png);
    await b.request('/api/auth/logout', 'POST', { scope: 'download' });
    expect((await b.request(path)).status).toBe(401);
  });
  it('rejects disguised active content, oversized, expired, and deleted image previews', async () => {
    const b = await start();
    const file = await ready(
      b,
      undefined,
      'pretend.png',
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    );
    const path = '/api/files/' + file.id + '/preview';
    expect((await b.request(path)).status).toBe(415);
    await env.DB.prepare('UPDATE files SET size_bytes=?1,actual_size_bytes=?1 WHERE id=?2')
      .bind(10 * 1024 * 1024 + 1, file.id)
      .run();
    expect((await b.request(path)).status).toBe(415);
    await env.DB.prepare('UPDATE files SET expires_at=? WHERE id=?')
      .bind(Date.now() - 1, file.id)
      .run();
    expect((await b.request(path)).status).toBe(404);
    await env.DB.prepare("UPDATE files SET state='DELETED',expires_at=? WHERE id=?")
      .bind(Date.now() + 60000, file.id)
      .run();
    expect((await b.request(path)).status).toBe(404);
  });
  it('keeps a batch together across group pages and retains standalone legacy files', async () => {
    const b = await start();
    const a = await ready(b, 'together'),
      other = await ready(b),
      z = await ready(b, 'together');
    expect(a.batch_id).toBe(z.batch_id);
    expect(other.batch_id).toBeNull();
    const response = await b.request('/api/file-groups');
    expect(response.status).toBe(200);
    const list = await response.json<{ files: { id: string; batchId: string | null }[] }>();
    expect(
      list.files
        .filter((f) => f.batchId === a.batch_id)
        .map((f) => f.id)
        .sort(),
    ).toEqual([a.id, z.id].sort());
    // Make one group larger than the old 25-file page boundary.
    for (let i = 0; i < 25; i++) await ready(b, 'together', `part-${i}.txt`);
    const full = await (
      await b.request('/api/file-groups')
    ).json<{ files: { id: string; batchId: string | null }[]; nextCursor: string | null }>();
    expect(full.files.filter((f) => f.batchId === a.batch_id)).toHaveLength(27);
    expect(full.nextCursor).toBeNull();
  });
  it('accepts a stable shortcut batch key while leaving old shortcut requests compatible', async () => {
    const token = 'S'.repeat(43),
      device = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO trusted_devices(id,name,kind,token_hash,created_at,last_used_at) VALUES(?,?,'shortcut',?,?,?)",
    )
      .bind(device, 'shortcut', await hash(token), Date.now(), Date.now())
      .run();
    const b = new Browser();
    const ids: string[] = [];
    for (const batchKey of ['same-run', 'same-run', undefined]) {
      const r = await b.request(
        '/api/shortcut/uploads',
        'POST',
        {
          filename: 'x.png',
          sizeBytes: 3,
          retentionSeconds: 86400,
          ...(batchKey ? { batchKey } : {}),
        },
        { Authorization: 'Bearer ' + token, 'Idempotency-Key': crypto.randomUUID() },
      );
      expect(r.status).toBe(201);
      ids.push((await r.json<UploadCreated>()).id);
    }
    const rows = await Promise.all(
      ids.map((id) =>
        env.DB.prepare('SELECT batch_id FROM files WHERE id=?').bind(id).first<string>('batch_id'),
      ),
    );
    expect(rows[0]).toBe(rows[1]);
    expect(rows[0]).toBeTruthy();
    expect(rows[2]).toBeNull();
  });
  it('streams only selected files, disambiguates names, and binds ZIP to the unlocked session', async () => {
    const b = await start(),
      a = await ready(b, 'zip'),
      z = await ready(b, 'zip'),
      other = await ready(b, undefined, 'not-selected.txt');
    const create = await b.request('/api/files/archive', 'POST', { ids: [a.id, z.id] });
    expect(create.status).toBe(200);
    const ticket = await create.json<{ url: string }>();
    expect((await new Browser().request(ticket.url)).status).toBe(401);
    const another = new Browser();
    await another.status();
    await another.request('/api/download/unlock', 'POST', { pin: '4827' });
    await another.status();
    expect((await another.request(ticket.url)).status).toBe(404);
    const zip = await b.request(ticket.url);
    expect(zip.headers.get('Content-Type')).toBe('application/zip');
    const body = new Uint8Array(await zip.arrayBuffer()),
      text = new TextDecoder().decode(body);
    expect(text).toContain('사진.png');
    expect(text).toContain('사진 (2).png');
    expect(text).not.toContain(other.filename);
    expect(new DataView(body.buffer).getUint32(body.length - 22, true)).toBe(0x06054b50);
    await env.DB.prepare('UPDATE files SET expires_at=? WHERE id=?')
      .bind(Date.now() - 1, a.id)
      .run();
    expect((await b.request(ticket.url)).status).toBe(409);
    expect((await b.request('/api/files/archive', 'POST', { ids: [a.id] })).status).toBe(409);
  });
  it('deletes only checked files without another code on a trusted browser', async () => {
    const b = await start(),
      a = await ready(b, 'delete'),
      z = await ready(b, 'delete'),
      keep = await ready(b, 'delete');
    expect(
      (await b.request('/api/files/delete', 'POST', { ids: [a.id, z.id] }, { 'X-CSRF-Token': '' }))
        .status,
    ).toBe(403);
    const r = await b.request('/api/files/delete', 'POST', { ids: [a.id, z.id] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      results: expect.arrayContaining([
        { id: a.id, state: 'DELETED' },
        { id: z.id, state: 'DELETED' },
      ]),
    });
    expect(await env.BUCKET.head(a.final_key)).toBeNull();
    expect(await env.BUCKET.head(keep.final_key)).not.toBeNull();
    expect((await b.request('/api/files/delete', 'POST', { ids: [a.id, z.id] })).status).toBe(200);
  });
  it('binds one-use batch deletion grants to exactly the selected IDs', async () => {
    const b = await start(false),
      a = await ready(b),
      keep = await ready(b);
    expect((await b.request('/api/files/delete', 'POST', { ids: [a.id] })).status).toBe(403);
    const token = 'batch-test-grant';
    await env.DB.prepare(
      'INSERT INTO admin_grants(id,token_hash,purpose,target_id,expires_at) VALUES(?,?,?,?,?)',
    )
      .bind(
        crypto.randomUUID(),
        await hash(token),
        'delete_files',
        await selectionTarget([a.id]),
        Date.now() + 300000,
      )
      .run();
    const h = { 'X-Admin-Grant': token };
    expect((await b.request('/api/files/delete', 'POST', { ids: [a.id, keep.id] }, h)).status).toBe(
      403,
    );
    expect((await b.request('/api/files/delete', 'POST', { ids: [a.id] }, h)).status).toBe(200);
    expect((await b.request('/api/files/delete', 'POST', { ids: [a.id] }, h)).status).toBe(403);
    expect(await env.BUCKET.head(keep.final_key)).not.toBeNull();
  });
  it('issues a batch deletion grant only after validating a target selection', async () => {
    const b = new Browser();
    await b.status();
    const code = new TOTP({ secret: env.TOTP_SECRET }).generate();
    expect(
      (await b.request('/api/auth/totp', 'POST', { code, intent: 'delete_files' })).status,
    ).toBe(400);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const response = await b.request('/api/auth/totp', 'POST', {
      code,
      intent: 'delete_files',
      targetIds: ids,
    });
    expect(response.status).toBe(200);
    const { grant } = await response.json<{ grant: string }>();
    expect(
      await env.DB.prepare('SELECT purpose,target_id FROM admin_grants WHERE token_hash=?')
        .bind(await hash(grant))
        .first(),
    ).toEqual({ purpose: 'delete_files', target_id: await selectionTarget(ids) });
  });
  it('reports a storage failure per file and finishes other selected deletions', async () => {
    const b = await start(),
      a = await ready(b),
      z = await ready(b),
      keep = await ready(b);
    const remove = env.BUCKET.delete.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, 'delete').mockImplementation(async (key) => {
      if (key === a.final_key) throw new Error('storage unavailable');
      return remove(key);
    });
    const response = await b.request('/api/files/delete', 'POST', { ids: [a.id, z.id] });
    expect(await response.json()).toMatchObject({
      results: expect.arrayContaining([
        { id: a.id, state: 'PENDING', message: expect.any(String) },
        { id: z.id, state: 'DELETED' },
      ]),
    });
    expect(await env.BUCKET.head(keep.final_key)).not.toBeNull();
    expect(await env.BUCKET.head(z.final_key)).toBeNull();
  });
  it('rejects an empty selection and makes safe non-colliding ZIP basenames', async () => {
    const b = await start();
    expect((await b.request('/api/files/archive', 'POST', { ids: [] })).status).toBe(400);
    expect(
      archiveNames([
        { filename: '../x.txt' },
        { filename: 'CON.txt' },
        { filename: 'same.png' },
        { filename: 'SAME.png' },
        { filename: '..' },
      ]),
    ).toEqual(['.._x.txt', '_CON.txt', 'same.png', 'SAME (2).png', 'file']);
  });
});
describe('recovery and reconciliation', () => {
  it('recovers through the real part endpoint when a D1 trigger rejects its first acknowledgement', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const file = (await env.DB.prepare('SELECT * FROM files WHERE id=?')
      .bind(u.id)
      .first<FileRow>())!;
    const payload = new Uint8Array([4, 5, 6]);
    const accepted = await env.BUCKET.resumeMultipartUpload(
      file.final_key,
      file.multipart_id!,
    ).uploadPart(1, payload);
    await env.DB.prepare(
      "CREATE TRIGGER reject_part_ack BEFORE UPDATE ON upload_parts WHEN NEW.state='DONE' AND OLD.state='SENDING' BEGIN SELECT RAISE(ABORT,'injected_ack_failure'); END",
    ).run();
    storageBrowser(b);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          partsXml({ final_key: file.final_key, multipart_id: file.multipart_id! }, [
            { partNumber: 1, bytes: 3, etag: accepted.etag },
          ]),
        ),
    );
    try {
      expect(
        (
          await b.request(`/api/uploads/${u.id}/parts/1`, 'PUT', payload, {
            Authorization: `Upload ${u.capability}`,
          })
        ).status,
      ).toBe(200);
      expect(
        await env.DB.prepare('SELECT state FROM upload_parts WHERE file_id=?')
          .bind(u.id)
          .first('state'),
      ).toBe('DONE');
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_part_ack').run();
    }
  });
  it('recovers R2-completed files after a D1 READY write failure without completing multipart twice', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const auth = { Authorization: `Upload ${u.capability}` };
    await b.request(`/api/uploads/${u.id}/parts/1`, 'PUT', new Uint8Array([1, 2, 3]), auth);
    await env.DB.prepare(
      "CREATE TRIGGER reject_ready_ack BEFORE UPDATE ON files WHEN NEW.state='READY' AND OLD.state='FINALIZING' BEGIN SELECT RAISE(ABORT,'injected_ready_failure'); END",
    ).run();
    try {
      expect((await b.request(`/api/uploads/${u.id}/complete`, 'POST', {}, auth)).status).toBe(500);
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_ready_ack').run();
    }
    expect(await env.BUCKET.head(`final/${u.id}`)).not.toBeNull();
    await env.DB.prepare('UPDATE files SET finalize_lease_until=0 WHERE id=?').bind(u.id).run();
    const recovered = await (
      await b.request(`/api/uploads/${u.id}`, 'GET', undefined, auth)
    ).json<{ state: string }>();
    expect(recovered.state).toBe('READY');
    expect(await env.DB.prepare('SELECT ready_bytes FROM quota_state').first('ready_bytes')).toBe(
      3,
    );
  });
  it('does not recover a fresh sending lease or overwrite on temporary storage lookup failures', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const auth = { Authorization: `Upload ${u.capability}` };
    storageBrowser(b);
    await env.DB.prepare(
      "INSERT INTO upload_parts(file_id,part_number,state,bytes,attempt_id,updated_at,lease_until) VALUES(?,1,'SENDING',3,?,?,?)",
    )
      .bind(u.id, crypto.randomUUID(), Date.now(), Date.now() + 60_000)
      .run();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    await b.request(`/api/uploads/${u.id}`, 'GET', undefined, auth);
    expect(spy).not.toHaveBeenCalled();
    await env.DB.prepare("UPDATE upload_parts SET state='UNCERTAIN' WHERE file_id=?")
      .bind(u.id)
      .run();
    expect(
      (await b.request(`/api/uploads/${u.id}/parts/1`, 'PUT', new Uint8Array([9, 9, 9]), auth))
        .status,
    ).toBe(409);
    expect(
      await env.DB.prepare('SELECT state FROM files WHERE id=?').bind(u.id).first('state'),
    ).toBe('UPLOADING');
  });
  it('rejects a wrong storage manifest before creating the final object', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const auth = { Authorization: `Upload ${u.capability}` };
    await b.request(`/api/uploads/${u.id}/parts/1`, 'PUT', new Uint8Array([1, 2, 3]), auth);
    const file = (await env.DB.prepare('SELECT * FROM files WHERE id=?')
      .bind(u.id)
      .first<FileRow>())!;
    storageBrowser(b);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          partsXml({ final_key: file.final_key, multipart_id: file.multipart_id! }, [
            { partNumber: 1, bytes: 3, etag: 'different' },
          ]),
        ),
    );
    const response = await b.request(`/api/uploads/${u.id}/complete`, 'POST', {}, auth);
    expect(response.status).toBe(422);
    expect(await env.BUCKET.head(file.final_key)).toBeNull();
  });
  it('stops an orphan scan when D1 cannot verify references', async () => {
    const key = `final/${crypto.randomUUID()}`;
    await env.BUCKET.put(key, 'keep');
    const now = Date.now();
    await reconcile(serviceContext(), 'report', now + 2 * 86400_000);
    const original = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('SELECT final_key,staging_key')) throw new Error('Injected DB failure');
      return original(sql);
    });
    await expect(
      reconcile(serviceContext(), 'delete_orphans', now + 3 * 86400_000),
    ).rejects.toThrow('Injected DB failure');
    expect(await env.BUCKET.head(key)).not.toBeNull();
  });
  it('recovers an accepted R2 part after the D1 acknowledgement was lost', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const file = (await env.DB.prepare('SELECT * FROM files WHERE id=?')
      .bind(u.id)
      .first<FileRow>())!;
    const accepted = await env.BUCKET.resumeMultipartUpload(
      file.final_key,
      file.multipart_id!,
    ).uploadPart(1, new Uint8Array([1, 2, 3]));
    await env.DB.prepare(
      "INSERT INTO upload_parts(file_id,part_number,state,bytes,attempt_id,updated_at) VALUES(?,1,'UNCERTAIN',3,?,?)",
    )
      .bind(u.id, crypto.randomUUID(), Date.now())
      .run();
    storageBrowser(b);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            partsXml({ final_key: file.final_key, multipart_id: file.multipart_id! }, [
              { partNumber: 1, bytes: 3, etag: accepted.etag },
            ]),
          ),
      );
    const headers = { Authorization: `Upload ${u.capability}` };
    const status = await (
      await b.request(`/api/uploads/${u.id}`, 'GET', undefined, headers)
    ).json<{ state: string; completedParts: unknown[] }>();
    expect(status.state).toBe('UPLOADING');
    expect(status.completedParts).toEqual([{ partNumber: 1, bytes: 3 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await b.request(`/api/uploads/${u.id}/complete`, 'POST', {}, headers)).status).toBe(
      200,
    );
    expect([
      ...new Uint8Array(await (await env.BUCKET.get(file.final_key))!.arrayBuffer()),
    ]).toEqual([1, 2, 3]);
  });
  it('never overwrites an uncertain part when ListParts returns no accepted part', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const file = (await env.DB.prepare('SELECT * FROM files WHERE id=?')
      .bind(u.id)
      .first<FileRow>())!;
    await env.DB.prepare(
      "INSERT INTO upload_parts(file_id,part_number,state,bytes,attempt_id,updated_at) VALUES(?,1,'UNCERTAIN',3,?,?)",
    )
      .bind(u.id, crypto.randomUUID(), Date.now())
      .run();
    storageBrowser(b);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(partsXml({ final_key: file.final_key, multipart_id: file.multipart_id! }, [])),
    );
    const response = await b.request(
      `/api/uploads/${u.id}/parts/1`,
      'PUT',
      new Uint8Array([9, 9, 9]),
      { Authorization: `Upload ${u.capability}` },
    );
    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare('SELECT state FROM files WHERE id=?').bind(u.id).first('state'),
    ).toBe('UPLOADING');
    expect(
      await env.DB.prepare('SELECT state FROM upload_parts WHERE file_id=?')
        .bind(u.id)
        .first('state'),
    ).toBe('UNCERTAIN');
  });
  it('fences a stale SENDING lease and rejects a recovered part of the wrong size', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const file = (await env.DB.prepare('SELECT * FROM files WHERE id=?')
      .bind(u.id)
      .first<FileRow>())!;
    await env.DB.prepare(
      "INSERT INTO upload_parts(file_id,part_number,state,bytes,attempt_id,updated_at,lease_until) VALUES(?,1,'SENDING',3,?,?,?)",
    )
      .bind(u.id, crypto.randomUUID(), Date.now() - 1000, Date.now() - 1)
      .run();
    storageBrowser(b);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        partsXml({ final_key: file.final_key, multipart_id: file.multipart_id! }, [
          { partNumber: 1, bytes: 2, etag: 'abc' },
        ]),
      ),
    );
    expect(
      (
        await b.request(`/api/uploads/${u.id}`, 'GET', undefined, {
          Authorization: `Upload ${u.capability}`,
        })
      ).status,
    ).toBe(422);
    expect(
      await env.DB.prepare('SELECT state FROM files WHERE id=?').bind(u.id).first('state'),
    ).toBe('FAILED');
  });
  it('rejects XML entity declarations, wrong upload identities and stuck pagination', () => {
    const file = { final_key: 'final/x', multipart_id: 'upload-x' };
    expect(() =>
      decodeParts(
        '<!DOCTYPE x [<!ENTITY y "value">]><x/>',
        file.final_key,
        file.multipart_id,
        0,
        100,
      ),
    ).toThrow();
    expect(() =>
      decodeParts(partsXml(file, []), 'final/other', file.multipart_id, 0, 100),
    ).toThrow();
    expect(() =>
      decodeParts(
        partsXml(file, [{ partNumber: 1, bytes: 3, etag: 'abc' }], true, 0),
        file.final_key,
        file.multipart_id,
        0,
        100,
      ),
    ).toThrow();
  });
  it('does not report cancellation when finalization has already won the race', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const stale = (await env.DB.prepare('SELECT * FROM files WHERE id=?')
      .bind(u.id)
      .first<FileRow>())!;
    await env.DB.prepare("UPDATE files SET state='FINALIZING' WHERE id=?").bind(u.id).run();
    await expect(cancelFile(serviceContext(), stale)).rejects.toMatchObject({
      code: 'ALREADY_FINALIZING',
    });
  });
  it('reports quota drift without mutation and repairs counters atomically when requested', async () => {
    const b = new Browser();
    await b.login();
    await b.upload(3);
    await env.DB.prepare('UPDATE quota_state SET reserved_bytes=77').run();
    const report = await reconcile(serviceContext());
    expect(report.quotaBefore.expectedReserved).toBe(3);
    expect(report.quotaAfter.reserved).toBe(77);
    const repaired = await reconcile(serviceContext(), 'repair_quota');
    expect(repaired.quotaAfter.reserved).toBe(3);
  });
  it('requires a fresh, purpose-bound, one-use grant for maintenance even for a trusted device', async () => {
    const b = new Browser();
    await b.login(true);
    expect((await b.request('/api/maintenance/reconcile', 'POST', { mode: 'report' })).status).toBe(
      403,
    );
    const grantToken = 'G'.repeat(43);
    await env.DB.prepare(
      "INSERT INTO admin_grants(id,token_hash,purpose,expires_at) VALUES(?,?,'maintenance_report',?)",
    )
      .bind(crypto.randomUUID(), await hash(grantToken), Date.now() + 60_000)
      .run();
    const headers = { 'X-Admin-Grant': grantToken };
    expect(
      (await b.request('/api/maintenance/reconcile', 'POST', { mode: 'repair_quota' }, headers))
        .status,
    ).toBe(403);
    expect(
      (await b.request('/api/maintenance/reconcile', 'POST', { mode: 'report' }, headers)).status,
    ).toBe(200);
    expect(
      (await b.request('/api/maintenance/reconcile', 'POST', { mode: 'report' }, headers)).status,
    ).toBe(403);
  });
  it('keeps young and unknown objects, observes old orphans twice, and only deletes in explicit mode', async () => {
    const key = `final/${crypto.randomUUID()}`;
    await env.BUCKET.put(key, 'orphan');
    await env.BUCKET.put('final/unrecognized', 'keep');
    const now = Date.now();
    expect((await reconcile(serviceContext(), 'report', now)).candidates).toBe(0);
    const first = await reconcile(serviceContext(), 'delete_orphans', now + 2 * 86400_000);
    expect(first.candidates).toBe(1);
    expect(first.deleted).toBe(0);
    const second = await reconcile(serviceContext(), 'report', now + 3 * 86400_000);
    expect(second.eligible).toBe(1);
    expect(second.deleted).toBe(0);
    expect(
      (await reconcile(serviceContext(), 'delete_orphans', now + 3 * 86400_000 + 1)).deleted,
    ).toBe(1);
    expect(await env.BUCKET.head(key)).toBeNull();
    expect(await env.BUCKET.head('final/unrecognized')).not.toBeNull();
  });
  it('stops orphan deletion when a DB reference appears between observations', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const key = `final/${crypto.randomUUID()}`;
    await env.BUCKET.put(key, 'safe');
    const now = Date.now();
    await reconcile(serviceContext(), 'report', now + 2 * 86400_000);
    await env.DB.prepare('UPDATE files SET staging_key=? WHERE id=?').bind(key, u.id).run();
    expect((await reconcile(serviceContext(), 'delete_orphans', now + 3 * 86400_000)).deleted).toBe(
      0,
    );
    expect(await env.BUCKET.head(key)).not.toBeNull();
  });
  it('protects staging API and assets and fails closed when the gate secret is absent', async () => {
    const runtime = { ...env, ENVIRONMENT: 'staging', STAGING_GATE_SECRET: 'test-only-gate' };
    for (const path of ['/api/health', '/upload', '/assets/app.js'])
      expect(
        (
          await app.fetch(
            new Request('https://staging.example' + path),
            runtime,
            createExecutionContext(),
          )
        ).status,
      ).toBe(404);
    expect(
      (
        await app.fetch(
          new Request('https://staging.example/api/health', {
            headers: { 'X-Staging-Token': 'test-only-gate' },
          }),
          runtime,
          createExecutionContext(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          new Request('https://staging.example/api/health'),
          { ...runtime, STAGING_GATE_SECRET: '' },
          createExecutionContext(),
        )
      ).status,
    ).toBe(404);
  });
});
describe('authentication and authorization', () => {
  it('protects file lists and keeps initial metadata private', async () => {
    const b = new Browser();
    expect((await b.request('/api/files')).status).toBe(401);
    const s = await b.status();
    expect(s.uploadAuth).toBe('none');
    expect(s.downloadUnlocked).toBe(false);
    expect(s).not.toHaveProperty('files');
  });
  it('rejects cross-origin and missing CSRF mutations', async () => {
    const b = new Browser();
    await b.status();
    const r = await b.request(
      '/api/download/unlock',
      'POST',
      { pin: '4827', remember: false },
      { Origin: 'https://evil.example', 'X-CSRF-Token': '' },
    );
    expect(r.status).toBe(403);
  });
  it('does not grant upload rights with the download PIN', async () => {
    const b = new Browser();
    await b.status();
    expect(
      (await b.request('/api/download/unlock', 'POST', { pin: '4827', remember: false })).status,
    ).toBe(200);
    await b.status();
    expect(
      (
        await b.request(
          '/api/uploads',
          'POST',
          { filename: 'x', sizeBytes: 1, retentionSeconds: 3600 },
          { 'Idempotency-Key': 'test' },
        )
      ).status,
    ).toBe(401);
  });
  it('only consumes the same TOTP step once', async () => {
    const a = new Browser(),
      b = new Browser();
    await Promise.all([a.status(), b.status()]);
    const code = new TOTP({ secret: env.TOTP_SECRET }).generate();
    const result = await Promise.all([
      a.request('/api/auth/totp', 'POST', { code, intent: 'upload' }),
      b.request('/api/auth/totp', 'POST', { code, intent: 'upload' }),
    ]);
    expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it('enforces the sliding attempt limit under concurrency', async () => {
    const b = new Browser();
    await b.status();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        b.request('/api/auth/totp', 'POST', { code: 'bad', intent: 'upload' }),
      ),
    );
    expect(responses.filter((r) => r.status === 400)).toHaveLength(5);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(7);
  });
  it('keeps download sessions separate from upload sessions', async () => {
    const b = new Browser();
    await b.login();
    expect((await b.request('/api/files')).status).toBe(401);
    expect((await b.request('/api/devices')).status).toBe(403);
  });
});
describe('file lifetime', () => {
  it('continues an admitted upload after its parent session naturally expires', async () => {
    const b = new Browser();
    await b.login();
    const upload = await b.upload();
    await env.DB.prepare('UPDATE temp_sessions SET expires_at=?')
      .bind(Date.now() - 1)
      .run();
    await b.status();
    const newUpload = await b.request(
      '/api/uploads',
      'POST',
      { filename: 'new', sizeBytes: 1, retentionSeconds: 3600 },
      { 'Idempotency-Key': 'after-expiry' },
    );
    expect(newUpload.status).toBe(401);
    const headers = { Authorization: `Upload ${upload.capability}` };
    const part = await b.request(
      `/api/uploads/${upload.id}/parts/1`,
      'PUT',
      new Uint8Array([1, 2, 3]),
      headers,
    );
    expect(part.status).toBe(200);
    const complete = await b.request(`/api/uploads/${upload.id}/complete`, 'POST', {}, headers);
    expect(complete.status).toBe(200);
    const result = await complete.json<{
      state: string;
      result: { completedAt: number; expiresAt: number };
    }>();
    expect(result.state).toBe('READY');
    expect(result.result.expiresAt - result.result.completedAt).toBe(86_400_000);
    const duplicate = await b.request(`/api/uploads/${upload.id}/complete`, 'POST', {}, headers);
    expect(await duplicate.json()).toEqual(result);
    await b.request('/api/download/unlock', 'POST', { pin: '4827', remember: false });
    await b.status();
    const download = await b.request(`/api/files/${upload.id}/download`);
    expect(download.status).toBe(200);
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(download.headers.get('Content-Disposition')).toContain('filename*=UTF-8');
  });
  it('rejects a capability for a different upload', async () => {
    const b = new Browser();
    await b.login();
    const a = await b.upload(),
      d = await b.upload();
    const r = await b.request(`/api/uploads/${d.id}/parts/1`, 'PUT', new Uint8Array([1, 2, 3]), {
      Authorization: `Upload ${a.capability}`,
    });
    expect(r.status).toBe(404);
  });
  it('revocation blocks an existing capability', async () => {
    const b = new Browser();
    await b.login(true);
    const u = await b.upload();
    await env.DB.prepare('UPDATE trusted_devices SET revoked_at=?').bind(Date.now()).run();
    expect(
      (
        await b.request(`/api/uploads/${u.id}`, 'GET', undefined, {
          Authorization: `Upload ${u.capability}`,
        })
      ).status,
    ).toBe(403);
  });
  it('does not complete a missing manifest', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    expect(
      (
        await b.request(
          `/api/uploads/${u.id}/complete`,
          'POST',
          {},
          { Authorization: `Upload ${u.capability}` },
        )
      ).status,
    ).toBe(409);
  });
  it('rejects wrong-sized parts before touching storage', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    const result = await b.request(`/api/uploads/${u.id}/parts/1`, 'PUT', new Uint8Array([1, 2]), {
      Authorization: `Upload ${u.capability}`,
    });
    expect(result.status).toBe(422);
    expect(
      (
        await env.DB.prepare('SELECT state FROM files WHERE id=?')
          .bind(u.id)
          .first<{ state: string }>()
      )?.state,
    ).toBe('UPLOADING');
    expect(
      await env.DB.prepare('SELECT file_id FROM upload_parts WHERE file_id=?').bind(u.id).first(),
    ).toBeNull();
  });
  it('replays upload creation and rejects changed bodies', async () => {
    const b = new Browser();
    await b.login();
    const data = { filename: 'same.txt', sizeBytes: 3, retentionSeconds: 3600 };
    const h = { 'Idempotency-Key': 'same-request' };
    const a = await b.request('/api/uploads', 'POST', data, h);
    const d = await b.request('/api/uploads', 'POST', data, h);
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual(await a.json());
    expect((await b.request('/api/uploads', 'POST', { ...data, sizeBytes: 4 }, h)).status).toBe(
      409,
    );
  });
  it('atomically refuses parallel quota oversubscription', async () => {
    const b = new Browser();
    await b.login();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        b.request(
          '/api/uploads',
          'POST',
          { filename: 'large', sizeBytes: 32 * 1024 ** 3, retentionSeconds: 3600 },
          { 'Idempotency-Key': crypto.randomUUID() },
        ),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(3);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(1);
    expect(
      (
        await env.DB.prepare('SELECT reserved_bytes FROM quota_state').first<{
          reserved_bytes: number;
        }>()
      )?.reserved_bytes,
    ).toBe(96 * 1024 ** 3);
  });
  it('cleans cancelled uploads and releases quota once', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    expect(
      (
        await b.request(
          `/api/uploads/${u.id}`,
          'DELETE',
          {},
          { Authorization: `Upload ${u.capability}` },
        )
      ).status,
    ).toBe(202);
    expect((await b.request('/api/local/cleanup', 'POST', {})).status).toBe(200);
    await b.request('/api/local/cleanup', 'POST', {});
    expect(
      (
        await env.DB.prepare('SELECT reserved_bytes FROM quota_state').first<{
          reserved_bytes: number;
        }>()
      )?.reserved_bytes,
    ).toBe(0);
  });
  it('finalizes a shortcut from staging and keeps final bytes immutable', async () => {
    const b = new Browser();
    await b.status();
    const token = 'A'.repeat(43),
      deviceId = crypto.randomUUID(),
      now = Date.now();
    await env.DB.prepare(
      "INSERT INTO trusted_devices(id,name,kind,token_hash,created_at,last_used_at) VALUES(?,'shortcut','shortcut',?,?,?)",
    )
      .bind(deviceId, await hash(token), now, now)
      .run();
    const res = await b.request(
      '/api/shortcut/uploads',
      'POST',
      { filename: 'phone.txt', sizeBytes: 3, retentionSeconds: 3600 },
      { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'shortcut-test' },
    );
    expect(res.status).toBe(201);
    const u = await res.json<UploadCreated>();
    await b.request(new URL(u.putUrl!).pathname, 'PUT', new Uint8Array([4, 5, 6]), u.putHeaders!);
    const complete = await b.request(
      `/api/uploads/${u.id}/complete`,
      'POST',
      {},
      { Authorization: `Upload ${u.capability}` },
    );
    expect(complete.status).toBe(200);
    const row = await env.DB.prepare('SELECT staging_key,final_key FROM files WHERE id=?')
      .bind(u.id)
      .first<{ staging_key: string; final_key: string }>();
    await env.BUCKET.put(row!.staging_key, new Uint8Array([7, 8, 9]));
    const final = await env.BUCKET.get(row!.final_key);
    expect([...new Uint8Array(await final!.arrayBuffer())]).toEqual([4, 5, 6]);
  });
});
describe('shared validation', () => {
  it('handles chunk boundaries and header-safe filenames', () => {
    expect(partBytes(POLICY.partSize + 1, 2)).toBe(1);
    expect(partBytes(1, 0)).toBe(0);
    expect(sanitizeFilename('../evil\r\n.txt')).toBe('.._evil__.txt');
    expect(disposition('한글.zip')).not.toContain('\r');
  });
  it('rejects truncated streams even without a Content-Length header', async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    await expect(
      pipeExact(input, 3, async (stream) => {
        const reader = stream.getReader();
        while (!(await reader.read()).done) {
          /* Drain without buffering. */
        }
      }),
    ).rejects.toThrow();
  });
  it('rejects oversized streams without buffering the file', async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    await expect(
      pipeExact(input, 3, async (stream) => {
        const reader = stream.getReader();
        while (!(await reader.read()).done) {
          /* Drain without buffering. */
        }
      }),
    ).rejects.toThrow();
  });
});
describe('expiry, retries and maintenance', () => {
  it('keeps confirmed part bytes unchanged on a repeated PUT', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload(),
      headers = { Authorization: `Upload ${u.capability}` };
    const first = await b.request(
      `/api/uploads/${u.id}/parts/1`,
      'PUT',
      new Uint8Array([1, 2, 3]),
      headers,
    );
    const second = await b.request(
      `/api/uploads/${u.id}/parts/1`,
      'PUT',
      new Uint8Array([8, 8, 8]),
      headers,
    );
    expect(await second.json()).toEqual(await first.json());
    await b.request(`/api/uploads/${u.id}/complete`, 'POST', {}, headers);
    const row = await env.DB.prepare('SELECT final_key FROM files WHERE id=?')
      .bind(u.id)
      .first<{ final_key: string }>();
    expect([
      ...new Uint8Array(await (await env.BUCKET.get(row!.final_key))!.arrayBuffer()),
    ]).toEqual([1, 2, 3]);
  });
  it('hides expired READY files before physical cleanup runs', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload(),
      headers = { Authorization: `Upload ${u.capability}` };
    await b.request(`/api/uploads/${u.id}/parts/1`, 'PUT', new Uint8Array([1, 2, 3]), headers);
    await b.request(`/api/uploads/${u.id}/complete`, 'POST', {}, headers);
    await env.DB.prepare('UPDATE files SET expires_at=? WHERE id=?')
      .bind(Date.now() - 1, u.id)
      .run();
    await b.request('/api/download/unlock', 'POST', { pin: '4827', remember: false });
    await b.status();
    expect((await (await b.request('/api/files')).json<{ files: unknown[] }>()).files).toEqual([]);
    expect((await b.request(`/api/files/${u.id}/download`)).status).toBe(404);
    const ctx = createExecutionContext();
    await worker.scheduled!(
      { scheduledTime: Date.now(), cron: '*/15 * * * *', noRetry() {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(
      (
        await env.DB.prepare('SELECT state FROM files WHERE id=?')
          .bind(u.id)
          .first<{ state: string }>()
      )?.state,
    ).toBe('DELETED');
    expect(
      (await env.DB.prepare('SELECT ready_bytes FROM quota_state').first<{ ready_bytes: number }>())
        ?.ready_bytes,
    ).toBe(0);
  });
  it('supports partial downloads and explicit locking', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload(),
      headers = { Authorization: `Upload ${u.capability}` };
    await b.request(`/api/uploads/${u.id}/parts/1`, 'PUT', new Uint8Array([1, 2, 3]), headers);
    await b.request(`/api/uploads/${u.id}/complete`, 'POST', {}, headers);
    await b.request('/api/download/unlock', 'POST', { pin: '4827', remember: false });
    await b.status();
    const range = await b.request(`/api/files/${u.id}/download`, 'GET', undefined, {
      Range: 'bytes=1-2',
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('Content-Range')).toBe('bytes 1-2/3');
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([2, 3]);
    await b.request('/api/auth/logout', 'POST', { scope: 'download' });
    expect((await b.request('/api/files')).status).toBe(401);
  });
  it('invalidates the old CSRF token after credentials change', async () => {
    const b = new Browser();
    await b.status();
    const code = new TOTP({ secret: env.TOTP_SECRET }).generate();
    await b.request('/api/auth/totp', 'POST', { code, intent: 'upload' });
    expect((await b.request('/api/auth/logout', 'POST', { scope: 'all' })).status).toBe(403);
    await b.status();
    expect((await b.request('/api/auth/logout', 'POST', { scope: 'all' })).status).toBe(200);
  });
  it('explicit logout cancels an admitted file after natural session expiry', async () => {
    const b = new Browser();
    await b.login();
    const u = await b.upload();
    await env.DB.prepare('UPDATE temp_sessions SET expires_at=?')
      .bind(Date.now() - 1)
      .run();
    expect(
      (
        await b.request('/api/auth/logout', 'POST', {
          scope: 'all',
          activeUploads: [{ id: u.id, capability: u.capability }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await env.DB.prepare('SELECT state FROM files WHERE id=?')
          .bind(u.id)
          .first<{ state: string }>()
      )?.state,
    ).toBe('CANCEL_REQUESTED');
    expect(
      (
        await b.request(`/api/uploads/${u.id}`, 'GET', undefined, {
          Authorization: `Upload ${u.capability}`,
        })
      ).status,
    ).toBe(403);
  });
  it('does not grant file-list or browser upload access to a shortcut Bearer', async () => {
    const b = new Browser();
    await b.status();
    const token = 'B'.repeat(43);
    await env.DB.prepare(
      "INSERT INTO trusted_devices(id,name,kind,token_hash,created_at,last_used_at) VALUES(?,'shortcut','shortcut',?,?,?)",
    )
      .bind(crypto.randomUUID(), await hash(token), Date.now(), Date.now())
      .run();
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'separate-scope' };
    expect((await b.request('/api/files', 'GET', undefined, headers)).status).toBe(401);
    expect(
      (
        await b.request(
          '/api/uploads',
          'POST',
          { filename: 'x', sizeBytes: 1, retentionSeconds: 3600 },
          headers,
        )
      ).status,
    ).toBe(401);
    expect((await b.request('/api/devices', 'GET', undefined, headers)).status).toBe(403);
  });
});

describe('immediate file deletion', () => {
  async function readyFile(b: Browser) {
    await b.login();
    const u = await b.upload();
    const headers = { Authorization: 'Upload ' + u.capability };
    expect(
      (
        await b.request(
          '/api/uploads/' + u.id + '/parts/1',
          'PUT',
          new Uint8Array([1, 2, 3]),
          headers,
        )
      ).status,
    ).toBe(200);
    expect(
      (await b.request('/api/uploads/' + u.id + '/complete', 'POST', {}, headers)).status,
    ).toBe(200);
    expect((await b.request('/api/download/unlock', 'POST', { pin: '4827' })).status).toBe(200);
    await b.status();
    return (await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(u.id).first<FileRow>())!;
  }
  async function deletionGrant(id: string, purpose = 'delete_file') {
    const token = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO admin_grants(id,token_hash,purpose,target_id,expires_at) VALUES(?,?,?,?,?)',
    )
      .bind(crypto.randomUUID(), await hash(token), purpose, id, Date.now() + POLICY.grantTtl)
      .run();
    return { 'X-Admin-Grant': token };
  }

  async function trustBrowser(b: Browser, kind = 'browser') {
    const token = crypto.randomUUID();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO trusted_devices(id,name,kind,token_hash,created_at,last_used_at) VALUES(?,?,?,?,?,?)',
    )
      .bind(id, 'Trusted deletion test', kind, await hash(token), Date.now(), Date.now())
      .run();
    b.cookies.set('dev-td', token);
    await b.status();
    return id;
  }
  it('deletes from a trusted browser without TOTP or grant and releases quota once', async () => {
    const b = new Browser();
    const file = await readyFile(b);
    await trustBrowser(b);
    expect((await b.status()).uploadAuth).toBe('trusted');
    const path = '/api/files/' + file.id;
    expect((await b.request(path, 'DELETE')).status).toBe(200);
    expect((await b.request(path, 'DELETE')).status).toBe(200);
    expect(await env.BUCKET.head(file.final_key)).toBeNull();
    expect(await env.DB.prepare('SELECT ready_bytes FROM quota_state').first('ready_bytes')).toBe(
      0,
    );
    expect(await env.DB.prepare('SELECT count(*) AS n FROM admin_grants').first('n')).toBe(0);
  });
  it('still requires Origin, CSRF and download unlock for a trusted browser', async () => {
    const b = new Browser();
    const file = await readyFile(b);
    await trustBrowser(b);
    const path = '/api/files/' + file.id;
    expect((await b.request(path, 'DELETE', {}, { 'X-CSRF-Token': '' })).status).toBe(403);
    expect((await b.request(path, 'DELETE', {}, { Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    await b.request('/api/auth/logout', 'POST', { scope: 'download' });
    await b.status();
    expect((await b.request(path, 'DELETE')).status).toBe(401);
    expect(await env.BUCKET.head(file.final_key)).not.toBeNull();
  });
  it.each(['revoked', 'forged', 'shortcut', 'expired temporary'])(
    'does not bypass TOTP for %s credentials',
    async (credential) => {
      const b = new Browser();
      const file = await readyFile(b);
      if (credential === 'revoked') {
        const id = await trustBrowser(b);
        await env.DB.prepare('UPDATE trusted_devices SET revoked_at=? WHERE id=?')
          .bind(Date.now(), id)
          .run();
      } else if (credential === 'forged') {
        b.cookies.set('dev-td', crypto.randomUUID());
      } else if (credential === 'shortcut') {
        await trustBrowser(b, 'shortcut');
      } else {
        await env.DB.prepare('UPDATE temp_sessions SET expires_at=?')
          .bind(Date.now() - 1)
          .run();
      }
      await b.status();
      expect((await b.request('/api/files/' + file.id, 'DELETE')).status).toBe(403);
      expect(await env.BUCKET.head(file.final_key)).not.toBeNull();
      expect(
        await env.DB.prepare('SELECT state FROM files WHERE id=?').bind(file.id).first('state'),
      ).toBe('READY');
    },
  );
  it('requires a file target for TOTP deletion and issues a bound single-use grant', async () => {
    const b = new Browser();
    await b.status();
    const code = new TOTP({ secret: env.TOTP_SECRET }).generate();
    expect(
      (await b.request('/api/auth/totp', 'POST', { code, intent: 'delete_file' })).status,
    ).toBe(400);
    const id = crypto.randomUUID();
    const response = await b.request('/api/auth/totp', 'POST', {
      code,
      intent: 'delete_file',
      targetId: id,
    });
    expect(response.status).toBe(200);
    const { grant } = await response.json<{ grant: string }>();
    expect(
      await env.DB.prepare(
        'SELECT purpose,target_id,consumed_at FROM admin_grants WHERE token_hash=?',
      )
        .bind(await hash(grant))
        .first(),
    ).toMatchObject({ purpose: 'delete_file', target_id: id, consumed_at: null });
  });
  it('rejects PIN alone, wrong grants, missing CSRF and locked downloads without deleting', async () => {
    const b = new Browser();
    const file = await readyFile(b);
    const path = '/api/files/' + file.id;
    expect((await b.request(path, 'DELETE')).status).toBe(403);
    expect(
      (await b.request(path, 'DELETE', {}, await deletionGrant(crypto.randomUUID()))).status,
    ).toBe(403);
    expect(
      (await b.request(path, 'DELETE', {}, await deletionGrant(file.id, 'revoke_device'))).status,
    ).toBe(403);
    const grant = await deletionGrant(file.id);
    expect((await b.request(path, 'DELETE', {}, { ...grant, 'X-CSRF-Token': '' })).status).toBe(
      403,
    );
    expect(
      (await b.request(path, 'DELETE', {}, { ...grant, Origin: 'https://evil.example' })).status,
    ).toBe(403);
    await b.request('/api/auth/logout', 'POST', { scope: 'download' });
    await b.status();
    expect((await b.request(path, 'DELETE', {}, grant)).status).toBe(401);
    expect(await env.BUCKET.head(file.final_key)).not.toBeNull();
    expect(
      await env.DB.prepare('SELECT state FROM files WHERE id=?').bind(file.id).first('state'),
    ).toBe('READY');
  });
  it('removes final and staging objects immediately, blocks download, and releases quota exactly once', async () => {
    const b = new Browser();
    const file = await readyFile(b);
    const path = '/api/files/' + file.id;
    const staging = 'staging/' + file.id;
    await env.BUCKET.put(staging, new Uint8Array([1, 2, 3]));
    await env.DB.prepare('UPDATE files SET staging_key=? WHERE id=?').bind(staging, file.id).run();
    const grant = await deletionGrant(file.id);
    expect((await b.request(path, 'DELETE', {}, grant)).status).toBe(200);
    expect(await env.BUCKET.head(file.final_key)).toBeNull();
    expect(await env.BUCKET.head(staging)).toBeNull();
    expect((await b.request(path + '/download')).status).toBe(404);
    expect((await (await b.request('/api/files')).json<{ files: unknown[] }>()).files).toEqual([]);
    expect(
      await env.DB.prepare('SELECT state,quota_bucket FROM files WHERE id=?').bind(file.id).first(),
    ).toMatchObject({ state: 'DELETED', quota_bucket: 'released' });
    expect((await b.request(path, 'DELETE', {}, grant)).status).toBe(403);
    expect((await b.request(path, 'DELETE', {}, await deletionGrant(file.id))).status).toBe(200);
    expect(
      await env.DB.prepare('SELECT ready_bytes,reserved_bytes FROM quota_state').first(),
    ).toMatchObject({ ready_bytes: 0, reserved_bytes: 0 });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM maintenance_jobs').first('n')).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_events WHERE event_type='file_deleted' AND resource_id=?",
      )
        .bind(file.id)
        .first('n'),
    ).toBe(1);
  });
  it('retains quota on storage failure and scheduled cleanup retries safely', async () => {
    const b = new Browser();
    const file = await readyFile(b);
    const deletion = vi
      .spyOn(env.BUCKET, 'delete')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    expect(
      (await b.request('/api/files/' + file.id, 'DELETE', {}, await deletionGrant(file.id))).status,
    ).toBe(503);
    expect(await env.BUCKET.head(file.final_key)).not.toBeNull();
    expect(await env.DB.prepare('SELECT ready_bytes FROM quota_state').first('ready_bytes')).toBe(
      3,
    );
    expect((await b.request('/api/files/' + file.id + '/download')).status).toBe(404);
    expect(
      await env.DB.prepare('SELECT attempts,lease_until FROM maintenance_jobs WHERE resource_id=?')
        .bind(file.id)
        .first(),
    ).toMatchObject({ attempts: 1, lease_until: null });
    deletion.mockRestore();
    await env.DB.prepare('UPDATE maintenance_jobs SET run_after=0 WHERE resource_id=?')
      .bind(file.id)
      .run();
    await b.request('/api/local/cleanup', 'POST');
    expect(await env.BUCKET.head(file.final_key)).toBeNull();
    expect(await env.DB.prepare('SELECT ready_bytes FROM quota_state').first('ready_bytes')).toBe(
      0,
    );
  });
});
