import type { AppContext, FileRow, PartRow, Principal } from './types';
import type { FileSummary, UploadCreated } from '../shared/contracts';
import { POLICY, uploadSchema, sanitizeFilename, partBytes } from '../shared/contracts';
import { hash, randomToken, encrypt, decrypt } from './crypto';
import { json, isLocal } from './http';
import { uploadCapability } from './auth';
import { ApiError, fail } from './errors';
import {
  objectMetadata,
  pipeExact,
  presign,
  promote,
  canListParts,
  verifyManifest,
} from './storage';
import { PART_LEASE_MS, recoverPart, recoverFileParts } from './recovery';
export function summary(file: FileRow): FileSummary | null {
  return file.state === 'READY' && file.completed_at && file.expires_at
    ? {
        id: file.id,
        filename: file.filename,
        sizeBytes: file.size_bytes,
        completedAt: file.completed_at,
        expiresAt: file.expires_at,
      }
    : null;
}
export async function loadFile(c: AppContext, id: string): Promise<FileRow> {
  const file = await c.env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first<FileRow>();
  if (!file) fail(404, 'UPLOAD_UNAVAILABLE', '업로드를 찾을 수 없습니다.');
  return file;
}
export async function createUpload(
  c: AppContext,
  p: Principal,
  shortcut = false,
): Promise<Response> {
  const body = await json(c, uploadSchema);
  let filename: string;
  try {
    filename = sanitizeFilename(body.filename);
  } catch {
    fail(400, 'INVALID_FILENAME', '파일 이름은 UTF-8 255바이트 이하여야 합니다.');
  }
  if (shortcut && body.sizeBytes > POLICY.shortcutMax)
    fail(413, 'FILE_TOO_LARGE', '단축어는 최대 5 GiB까지 전송할 수 있습니다.');
  const key = c.req.header('Idempotency-Key');
  if (!key || key.length > 100) fail(400, 'IDEMPOTENCY_REQUIRED', '전송 요청 식별자가 필요합니다.');
  const keyHash = await hash(key),
    requestHash = await hash(JSON.stringify({ body, shortcut }));
  const existing = await c.env.DB.prepare(
    'SELECT k.request_hash,k.response_ciphertext,k.expires_at,f.state FROM idempotency_keys k JOIN files f ON f.id=k.file_id WHERE k.principal_id=? AND k.key_hash=?',
  )
    .bind(p.id, keyHash)
    .first<{
      request_hash: string;
      response_ciphertext: string | null;
      expires_at: number;
      state: string;
    }>();
  if (existing) {
    if (existing.request_hash !== requestHash)
      fail(409, 'IDEMPOTENCY_CONFLICT', '같은 요청 식별자의 파일 정보가 변경되었습니다.');
    if (
      !existing.response_ciphertext &&
      ['CREATING', 'UPLOADING'].includes(existing.state) &&
      existing.expires_at > Date.now()
    )
      throw new ApiError(
        409,
        'CREATE_IN_PROGRESS',
        '전송 요청을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.',
        true,
        2,
      );
    if (!existing.response_ciphertext || existing.expires_at <= Date.now())
      fail(
        409,
        'CREATE_RESULT_UNAVAILABLE',
        '전송 준비 결과를 복구할 수 없습니다. 새 요청을 시작해 주세요.',
      );
    return c.json(
      JSON.parse(await decrypt(c.env.IDEMPOTENCY_SECRET, existing.response_ciphertext)),
      200,
    );
  }
  const now = Date.now(),
    id = crypto.randomUUID(),
    capability = randomToken();
  const response: UploadCreated = {
    id,
    state: 'UPLOADING',
    capability,
    capabilityExpiresAt: now + POLICY.capabilityTtl,
    partSizeBytes: POLICY.partSize,
    partCount: shortcut ? 1 : Math.ceil(body.sizeBytes / POLICY.partSize),
    serverNow: now,
  };
  const file: FileRow = {
    id,
    mode: shortcut ? 'shortcut_put' : 'web_multipart',
    state: 'CREATING',
    filename,
    declared_mime: body.mime,
    size_bytes: body.sizeBytes,
    retention_seconds: body.retentionSeconds,
    final_key: `final/${id}`,
    staging_key: shortcut ? `staging/${id}/${crypto.randomUUID()}` : null,
    multipart_id: null,
    capability_hash: await hash(capability),
    capability_expires_at: response.capabilityExpiresAt,
    owner_device_id: p.kind === 'device' ? p.id : null,
    owner_session_id: p.kind === 'session' ? p.id : null,
    created_at: now,
    last_activity_at: now,
    first_part_at: null,
    completed_at: null,
    expires_at: null,
    final_etag: null,
    actual_size_bytes: null,
    pinned_source_etag: null,
    finalize_started_at: null,
    finalize_lease_until: null,
    cancel_requested_at: null,
    quota_bucket: 'reserved',
  };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO files(id,mode,state,filename,declared_mime,size_bytes,retention_seconds,final_key,staging_key,capability_hash,capability_expires_at,owner_device_id,owner_session_id,created_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        file.mode,
        'CREATING',
        filename,
        body.mime,
        body.sizeBytes,
        body.retentionSeconds,
        file.final_key,
        file.staging_key,
        file.capability_hash,
        file.capability_expires_at,
        file.owner_device_id,
        file.owner_session_id,
        now,
        now,
      ),
      c.env.DB.prepare(
        'INSERT INTO idempotency_keys(principal_id,key_hash,request_hash,file_id,expires_at) VALUES(?,?,?,?,?)',
      ).bind(p.id, keyHash, requestHash, id, now + 600_000),
    ]);
  } catch (error) {
    const message = String(error);
    for (const code of ['STORAGE_QUOTA_EXCEEDED', 'DAILY_QUOTA_EXCEEDED', 'ACTIVE_UPLOAD_LIMIT'])
      if (message.includes(code))
        throw new ApiError(
          429,
          code,
          '임시 보관 공간 또는 동시 전송 한도를 초과했습니다.',
          true,
          60,
        );
    if (message.includes('UPLOAD_SESSION_EXPIRED'))
      fail(401, 'UPLOAD_SESSION_EXPIRED', '새 업로드를 시작하려면 다시 인증해 주세요.');
    if (message.includes('DEVICE_REVOKED'))
      fail(403, 'DEVICE_REVOKED', '이 기기의 권한이 해제되었습니다.');
    if (message.includes('UNIQUE constraint'))
      throw new ApiError(
        409,
        'CREATE_IN_PROGRESS',
        '동일한 요청이 처리 중입니다. 잠시 후 다시 시도해 주세요.',
        true,
        2,
      );
    throw error;
  }
  try {
    if (shortcut) {
      if (isLocal(c)) {
        response.putUrl = `${new URL(c.req.url).origin}/api/uploads/${id}/shortcut-body`;
        response.putHeaders = { Authorization: `Upload ${capability}` };
      } else {
        response.putUrl = await presign(c.env, file.staging_key!, 'PUT', 7200);
        response.putHeaders = {};
      }
    } else {
      const multipart = await c.env.BUCKET.createMultipartUpload(
        file.final_key,
        objectMetadata(file),
      );
      file.multipart_id = multipart.uploadId;
    }
    const changed = await c.env.DB.prepare(
      "UPDATE files SET state='UPLOADING',multipart_id=? WHERE id=? AND state='CREATING' RETURNING id",
    )
      .bind(file.multipart_id, id)
      .first();
    if (!changed) {
      // A cancellation may have won while R2 was creating the multipart upload.
      if (file.multipart_id)
        await c.env.BUCKET.resumeMultipartUpload(file.final_key, file.multipart_id).abort();
      throw new ApiError(409, 'UPLOAD_CANCELLED', '업로드가 취소되었습니다.');
    }
    await c.env.DB.prepare(
      'UPDATE idempotency_keys SET response_ciphertext=? WHERE principal_id=? AND key_hash=?',
    )
      .bind(await encrypt(c.env.IDEMPOTENCY_SECRET, JSON.stringify(response)), p.id, keyHash)
      .run();
    return c.json(response, 201);
  } catch (error) {
    if (file.multipart_id) {
      // Preserve the resource identifier even if the create acknowledgement failed.
      await c.env.DB.prepare('UPDATE files SET multipart_id=coalesce(multipart_id,?) WHERE id=?')
        .bind(file.multipart_id, id)
        .run();
    }
    await c.env.DB.prepare(
      "UPDATE files SET state='FAILED',last_error_code='CREATE_FAILED' WHERE id=? AND state IN('CREATING','UPLOADING')",
    )
      .bind(id)
      .run();
    throw error;
  }
}
export async function partUpload(c: AppContext): Promise<Response> {
  const id = c.req.param('id')!,
    n = Number(c.req.param('n')),
    file = await uploadCapability(c, id);
  if (file.state !== 'UPLOADING' || file.mode !== 'web_multipart' || !file.multipart_id)
    fail(409, 'INVALID_UPLOAD_STATE', '파일의 현재 상태에서는 전송할 수 없습니다.');
  const expected = partBytes(file.size_bytes, n);
  if (!expected) fail(400, 'INVALID_PART', '올바른 파일 부분 번호가 필요합니다.');
  if (!c.req.raw.body) fail(400, 'EMPTY_BODY', '파일 데이터가 필요합니다.');
  const declaredLength = c.req.header('Content-Length');
  if (declaredLength !== undefined && Number(declaredLength) !== expected)
    fail(422, 'SIZE_MISMATCH', '전송할 파일 부분의 크기가 일치하지 않습니다.');
  let previous = await c.env.DB.prepare(
    'SELECT * FROM upload_parts WHERE file_id=? AND part_number=?',
  )
    .bind(id, n)
    .first<PartRow>();
  if (previous && previous.state !== 'DONE') previous = await recoverPart(c, file, n);
  if (previous?.state === 'DONE')
    return c.json({ partNumber: n, etag: previous.etag, bytes: previous.bytes });
  if (previous)
    throw new ApiError(
      409,
      'PART_IN_PROGRESS',
      '이 부분의 전송 결과를 확인하고 있습니다.',
      true,
      3,
    );
  const attempt = crypto.randomUUID(),
    now = Date.now();
  const slot = await c.env.DB.prepare(
    `INSERT INTO upload_parts(file_id,part_number,state,bytes,attempt_id,updated_at,lease_until)
    SELECT ?,?,'SENDING',?,?,?,? WHERE EXISTS(SELECT 1 FROM files WHERE id=? AND state='UPLOADING') ON CONFLICT DO NOTHING RETURNING file_id`,
  )
    .bind(id, n, expected, attempt, now, now + PART_LEASE_MS, id)
    .first();
  if (!slot) throw new ApiError(409, 'PART_IN_PROGRESS', '전송 상태를 확인하고 있습니다.', true, 3);
  await c.env.DB.prepare(
    'UPDATE files SET first_part_at=coalesce(first_part_at,?),last_activity_at=? WHERE id=?',
  )
    .bind(now, now, id)
    .run();
  let uploaded: R2UploadedPart | undefined;
  try {
    const multipart = c.env.BUCKET.resumeMultipartUpload(file.final_key, file.multipart_id);
    await pipeExact(c.req.raw.body, expected, async (stream) => {
      uploaded = await multipart.uploadPart(n, stream);
    });
    if (!uploaded) throw new Error('PART_RESULT_MISSING');
    const saved = await c.env.DB.prepare(
      "UPDATE upload_parts SET state='DONE',etag=?,updated_at=? WHERE file_id=? AND part_number=? AND attempt_id=? AND state IN('SENDING','UNCERTAIN') AND EXISTS(SELECT 1 FROM files WHERE id=? AND state='UPLOADING') RETURNING file_id",
    )
      .bind(uploaded.etag, Date.now(), id, n, attempt, id)
      .first();
    if (!saved) throw new Error('PART_STATE_CHANGED');
    return c.json({ partNumber: n, etag: uploaded.etag, bytes: expected });
  } catch (error) {
    await c.env.DB.prepare(
      "UPDATE upload_parts SET state='UNCERTAIN',updated_at=? WHERE file_id=? AND part_number=? AND attempt_id=? AND state='SENDING'",
    )
      .bind(Date.now(), id, n, attempt)
      .run();
    const recovered = await recoverPart(c, file, n);
    if (recovered?.state === 'DONE')
      return c.json({ partNumber: n, etag: recovered.etag, bytes: recovered.bytes });
    throw new ApiError(
      503,
      'PART_UNCERTAIN',
      '파일 일부의 전송 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.',
      true,
      5,
    );
  }
}
export async function localShortcutBody(c: AppContext): Promise<Response> {
  if (!isLocal(c)) fail(404, 'NOT_FOUND', '요청을 찾을 수 없습니다.');
  const file = await uploadCapability(c, c.req.param('id')!);
  if (
    file.state !== 'UPLOADING' ||
    file.mode !== 'shortcut_put' ||
    !file.staging_key ||
    !c.req.raw.body
  )
    fail(409, 'INVALID_UPLOAD_STATE', '파일을 전송할 수 없습니다.');
  const declaredLength = c.req.header('Content-Length');
  if (declaredLength !== undefined && Number(declaredLength) !== file.size_bytes)
    fail(422, 'SIZE_MISMATCH', '전송할 파일의 크기가 일치하지 않습니다.');
  await pipeExact(c.req.raw.body, file.size_bytes, (stream) =>
    c.env.BUCKET.put(file.staging_key!, stream, { customMetadata: { fileId: file.id } }),
  );
  await c.env.DB.prepare(
    'UPDATE files SET first_part_at=coalesce(first_part_at,?),last_activity_at=? WHERE id=?',
  )
    .bind(Date.now(), Date.now(), file.id)
    .run();
  return c.body(null, 204);
}
export async function markReady(c: AppContext, file: FileRow): Promise<FileRow> {
  const object = await c.env.BUCKET.head(file.final_key);
  const metadataId = object?.customMetadata?.fileId || object?.customMetadata?.fileid;
  if (!object || object.size !== file.size_bytes || metadataId !== file.id)
    throw new ApiError(422, 'SIZE_MISMATCH', '전송된 파일을 검증하지 못했습니다.');
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE files SET state='READY',actual_size_bytes=?,final_etag=?,completed_at=?,expires_at=?,quota_bucket='ready',last_activity_at=? WHERE id=? AND state='FINALIZING'`,
  )
    .bind(object.size, object.etag, now, now + file.retention_seconds * 1000, now, file.id)
    .run();
  return loadFile(c, file.id);
}
export async function finalize(c: AppContext, file: FileRow): Promise<FileRow> {
  const object = await c.env.BUCKET.head(file.final_key);
  if (object) return markReady(c, file);
  if (file.mode === 'shortcut_put') {
    if (!file.pinned_source_etag)
      throw new ApiError(409, 'MISSING_SOURCE', '전송된 파일을 찾을 수 없습니다.');
    await promote(c, file, file.pinned_source_etag);
  } else {
    const parts = (
      await c.env.DB.prepare(
        "SELECT * FROM upload_parts WHERE file_id=? AND state='DONE' ORDER BY part_number",
      )
        .bind(file.id)
        .all<PartRow>()
    ).results;
    if (
      parts.length !== Math.ceil(file.size_bytes / POLICY.partSize) ||
      parts.some(
        (p, i) =>
          p.part_number !== i + 1 || p.bytes !== partBytes(file.size_bytes, i + 1) || !p.etag,
      )
    )
      throw new ApiError(409, 'PARTS_INCOMPLETE', '파일 전송이 아직 끝나지 않았습니다.');
    if (!file.multipart_id)
      throw new ApiError(409, 'INVALID_UPLOAD_STATE', '파일 전송 상태를 확인할 수 없습니다.');
    if (canListParts(c.env))
      await verifyManifest(
        c.env,
        file.final_key,
        file.multipart_id,
        parts.map((p) => ({ partNumber: p.part_number, bytes: p.bytes, etag: p.etag! })),
      );
    await c.env.BUCKET.resumeMultipartUpload(file.final_key, file.multipart_id).complete(
      parts.map((p) => ({ partNumber: p.part_number, etag: p.etag! })),
    );
  }
  return markReady(c, file);
}
export async function completeUpload(c: AppContext): Promise<Response> {
  let file = await uploadCapability(c, c.req.param('id')!);
  if (file.state === 'READY') return c.json({ state: 'READY', result: summary(file) });
  if (file.state === 'FINALIZING') return c.json({ state: 'FINALIZING', result: null }, 202);
  if (file.state !== 'UPLOADING')
    fail(409, 'INVALID_UPLOAD_STATE', '이 파일의 업로드를 완료할 수 없습니다.');
  let etag: string | null = null;
  if (file.mode === 'shortcut_put') {
    const source = await c.env.BUCKET.head(file.staging_key!);
    if (!source || source.size !== file.size_bytes)
      fail(422, 'SIZE_MISMATCH', '전송된 파일 크기가 일치하지 않습니다.');
    etag = source.etag;
  } else {
    const parts = (
      await c.env.DB.prepare('SELECT * FROM upload_parts WHERE file_id=? ORDER BY part_number')
        .bind(file.id)
        .all<PartRow>()
    ).results;
    if (
      parts.length !== Math.ceil(file.size_bytes / POLICY.partSize) ||
      parts.some(
        (p, i) =>
          p.state !== 'DONE' ||
          p.part_number !== i + 1 ||
          p.bytes !== partBytes(file.size_bytes, i + 1),
      )
    )
      fail(409, 'PARTS_INCOMPLETE', '파일 전송이 아직 끝나지 않았습니다.');
  }
  const locked = await c.env.DB.prepare(
    "UPDATE files SET state='FINALIZING',pinned_source_etag=?,finalize_started_at=?,finalize_lease_until=? WHERE id=? AND state='UPLOADING' RETURNING id",
  )
    .bind(etag, Date.now(), Date.now() + 600_000, file.id)
    .first();
  if (!locked) {
    const current = await loadFile(c, file.id);
    if (current.state === 'READY') return c.json({ state: 'READY', result: summary(current) });
    if (current.state === 'FINALIZING') return c.json({ state: 'FINALIZING', result: null }, 202);
    fail(409, 'INVALID_UPLOAD_STATE', '업로드가 취소되었거나 종료되었습니다.');
  }
  file = await loadFile(c, file.id);
  try {
    const ready = await finalize(c, file);
    return c.json({ state: ready.state, result: summary(ready) });
  } catch (error) {
    await c.env.DB.prepare('UPDATE files SET last_error_code=? WHERE id=?')
      .bind(error instanceof ApiError ? error.code : 'FINALIZE_FAILED', file.id)
      .run();
    throw error;
  }
}
export async function recoverFinalization(c: AppContext, file: FileRow): Promise<FileRow> {
  const now = Date.now();
  if (file.state !== 'FINALIZING' || (file.finalize_lease_until || 0) > now) return file;
  const lock = await c.env.DB.prepare(
    "UPDATE files SET finalize_lease_until=? WHERE id=? AND state='FINALIZING' AND coalesce(finalize_lease_until,0)<=? RETURNING id",
  )
    .bind(now + 600_000, file.id, now)
    .first();
  if (!lock) return loadFile(c, file.id);
  try {
    return await finalize(c, file);
  } catch (error) {
    const permanent = error instanceof ApiError && [409, 422].includes(error.status);
    if (
      permanent ||
      (file.finalize_started_at !== null && now - file.finalize_started_at >= 7200_000)
    ) {
      await c.env.DB.prepare(
        "UPDATE files SET state='FAILED',last_error_code=? WHERE id=? AND state='FINALIZING'",
      )
        .bind(error instanceof ApiError ? error.code : 'FINALIZE_RECOVERY_FAILED', file.id)
        .run();
    } else {
      await c.env.DB.prepare(
        "UPDATE files SET finalize_lease_until=?,last_error_code=? WHERE id=? AND state='FINALIZING'",
      )
        .bind(
          now + 60_000,
          error instanceof ApiError ? error.code : 'FINALIZE_RECOVERY_PENDING',
          file.id,
        )
        .run();
    }
    return loadFile(c, file.id);
  }
}
export async function cancelFile(c: AppContext, file: FileRow): Promise<void> {
  if (file.state === 'READY' || file.state === 'FINALIZING')
    fail(409, 'ALREADY_FINALIZING', '이미 완료되었거나 파일을 확인하고 있습니다.');
  const changed = await c.env.DB.prepare(
    "UPDATE files SET state='CANCEL_REQUESTED',cancel_requested_at=? WHERE id=? AND state IN('CREATING','UPLOADING','FAILED') RETURNING id",
  )
    .bind(Date.now(), file.id)
    .first();
  if (!changed) {
    const current = await loadFile(c, file.id);
    if (current.state === 'READY' || current.state === 'FINALIZING')
      fail(409, 'ALREADY_FINALIZING', '이미 완료되었거나 파일을 확인하고 있습니다.');
  }
}
export async function uploadStatus(c: AppContext): Promise<Response> {
  const file = await uploadCapability(c, c.req.param('id')!);
  if (file.state === 'UPLOADING' && file.mode === 'web_multipart') await recoverFileParts(c, file);
  const current = await recoverFinalization(c, await loadFile(c, file.id));
  const parts = (
    await c.env.DB.prepare(
      "SELECT part_number,bytes FROM upload_parts WHERE file_id=? AND state='DONE' ORDER BY part_number",
    )
      .bind(file.id)
      .all<{ part_number: number; bytes: number }>()
  ).results;
  return c.json({
    id: file.id,
    state: current.state,
    completedParts: parts.map((p) => ({ partNumber: p.part_number, bytes: p.bytes })),
    capabilityExpiresAt: file.capability_expires_at,
    result: summary(current),
  });
}
