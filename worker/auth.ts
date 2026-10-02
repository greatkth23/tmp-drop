import { TOTP } from 'otpauth';
import type { AppContext, FileRow, Principal } from './types';
import { cookie, isLocal, writeCookie } from './http';
import { hash, hmac, safeEqual } from './crypto';
import { ApiError, fail } from './errors';
export async function limitAuth(c: AppContext, purpose: 'totp' | 'pin'): Promise<void> {
  const now = Date.now(),
    perIp = purpose === 'totp' ? 5 : 10,
    global = purpose === 'totp' ? 60 : 100;
  const ip = c.req.header('CF-Connecting-IP') || (isLocal(c) ? 'local' : 'unknown');
  const key = await hmac(c.env.IP_HASH_SECRET, ip);
  const result = await c.env.DB.prepare(
    `INSERT INTO auth_attempts(id,purpose,ip_key,attempted_at)
    SELECT ?,?,?,? WHERE
    (SELECT count(*) FROM auth_attempts WHERE purpose=? AND ip_key=? AND attempted_at>?)<? AND
    (SELECT count(*) FROM auth_attempts WHERE purpose=? AND attempted_at>?)<? RETURNING id`,
  )
    .bind(
      crypto.randomUUID(),
      purpose,
      key,
      now,
      purpose,
      key,
      now - 300_000,
      perIp,
      purpose,
      now - 300_000,
      global,
    )
    .first();
  if (!result)
    throw new ApiError(
      429,
      'RATE_LIMITED',
      '시도 횟수를 초과했습니다. 5분 후 다시 시도해 주세요.',
      true,
      300,
    );
}
export async function consumeTotp(c: AppContext, code: string): Promise<void> {
  const now = Date.now();
  const totp = new TOTP({ secret: c.env.TOTP_SECRET, algorithm: 'SHA1', digits: 6, period: 30 });
  const delta = totp.validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) fail(401, 'INVALID_CODE', 'Authenticator 코드를 다시 확인해 주세요.');
  const result = await c.env.DB.prepare(
    'INSERT INTO totp_uses(secret_version,time_step,used_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING time_step',
  )
    .bind(c.env.TOTP_SECRET_VERSION, Math.floor(now / 30_000) + delta, now)
    .first();
  if (!result) fail(409, 'CODE_ALREADY_USED', '이미 사용한 코드입니다. 다음 코드를 입력해 주세요.');
}
export async function verifyPin(c: AppContext, pin: string): Promise<void> {
  const [a, b] = await Promise.all([
    hmac(c.env.CSRF_SECRET, pin),
    hmac(c.env.CSRF_SECRET, c.env.DOWNLOAD_PIN),
  ]);
  if (!safeEqual(a, b)) fail(401, 'INVALID_PIN', 'PIN을 다시 확인해 주세요.');
}
export async function browserPrincipal(c: AppContext, required = true): Promise<Principal | null> {
  const device = cookie(c, 'td');
  if (device) {
    const row = await c.env.DB.prepare(
      "SELECT id,name,last_used_at FROM trusted_devices WHERE token_hash=? AND kind='browser' AND revoked_at IS NULL",
    )
      .bind(await hash(device))
      .first<{ id: string; name: string; last_used_at: number }>();
    if (row) {
      if (row.last_used_at < Date.now() - 300_000) {
        await c.env.DB.prepare(
          'UPDATE trusted_devices SET last_used_at=? WHERE id=? AND revoked_at IS NULL',
        )
          .bind(Date.now(), row.id)
          .run();
        writeCookie(c, 'td', device, 365 * 86400);
      }
      return { id: row.id, kind: 'device', name: row.name, expiresAt: null };
    }
  }
  const session = cookie(c, 'ps');
  if (session) {
    const row = await c.env.DB.prepare(
      'SELECT id,expires_at FROM temp_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',
    )
      .bind(await hash(session), Date.now())
      .first<{ id: string; expires_at: number }>();
    if (row) return { id: row.id, kind: 'session', name: null, expiresAt: row.expires_at };
  }
  if (required) fail(401, 'UPLOAD_SESSION_EXPIRED', '새 파일을 올리려면 다시 인증해 주세요.');
  return null;
}
export async function shortcutPrincipal(c: AppContext): Promise<Principal> {
  const raw = c.req.header('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!raw) fail(401, 'UNAUTHORIZED', '기기 토큰이 필요합니다.');
  const row = await c.env.DB.prepare(
    "SELECT id,name,last_used_at FROM trusted_devices WHERE token_hash=? AND kind='shortcut' AND revoked_at IS NULL",
  )
    .bind(await hash(raw))
    .first<{ id: string; name: string; last_used_at: number }>();
  if (!row) fail(403, 'DEVICE_REVOKED', '이 기기의 업로드 권한이 해제되었습니다.');
  if (row.last_used_at < Date.now() - 300_000)
    await c.env.DB.prepare(
      'UPDATE trusted_devices SET last_used_at=? WHERE id=? AND revoked_at IS NULL',
    )
      .bind(Date.now(), row.id)
      .run();
  return { id: row.id, kind: 'device', name: row.name, expiresAt: null };
}
export async function downloadSession(
  c: AppContext,
  required = true,
): Promise<{ id: string; expires_at: number } | null> {
  const raw = cookie(c, 'da');
  let row = null;
  if (raw)
    row = await c.env.DB.prepare(
      'SELECT id,expires_at FROM download_sessions WHERE token_hash=? AND expires_at>? AND revoked_at IS NULL AND pin_version=?',
    )
      .bind(await hash(raw), Date.now(), c.env.PIN_VERSION)
      .first<{ id: string; expires_at: number }>();
  if (!row && required) fail(401, 'DOWNLOAD_LOCKED', '파일 목록을 보려면 PIN을 입력해 주세요.');
  return row;
}
export async function grant(c: AppContext, purpose: string, target?: string): Promise<void> {
  const token = c.req.header('X-Admin-Grant');
  if (!token) fail(403, 'REAUTH_REQUIRED', '기기 관리를 위해 다시 인증해 주세요.');
  const row = await c.env.DB.prepare(
    `UPDATE admin_grants SET consumed_at=? WHERE token_hash=? AND purpose=? AND target_id IS ? AND expires_at>? AND consumed_at IS NULL RETURNING id`,
  )
    .bind(Date.now(), await hash(token), purpose, target || null, Date.now())
    .first();
  if (!row) fail(403, 'REAUTH_REQUIRED', '관리 인증이 만료되었거나 이미 사용되었습니다.');
}
export async function uploadCapability(
  c: AppContext,
  id: string,
  rawOverride?: string,
): Promise<FileRow> {
  const raw =
    rawOverride || c.req.header('Authorization')?.match(/^Upload ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!raw) fail(401, 'UNAUTHORIZED', '파일 전송 권한이 필요합니다.');
  const row = await c.env.DB.prepare('SELECT * FROM files WHERE id=? AND capability_hash=?')
    .bind(id, await hash(raw))
    .first<FileRow>();
  if (!row) fail(404, 'UPLOAD_UNAVAILABLE', '업로드를 찾을 수 없습니다.');
  if (row.capability_expires_at <= Date.now())
    fail(401, 'CAPABILITY_EXPIRED', '이 파일의 전송 가능 시간이 끝났습니다.');
  // Deliberately do not inspect the parent session's natural expires_at here.
  const parent = row.owner_device_id
    ? await c.env.DB.prepare('SELECT revoked_at FROM trusted_devices WHERE id=?')
        .bind(row.owner_device_id)
        .first<{ revoked_at: number | null }>()
    : await c.env.DB.prepare('SELECT revoked_at FROM temp_sessions WHERE id=?')
        .bind(row.owner_session_id)
        .first<{ revoked_at: number | null }>();
  if (!parent || parent.revoked_at !== null)
    fail(403, 'DEVICE_REVOKED', '파일 전송 권한이 해제되었습니다.');
  return row;
}
