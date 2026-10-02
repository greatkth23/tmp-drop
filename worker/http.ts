import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { ZodType } from 'zod';
import type { AppContext } from './types';
import { fail } from './errors';
import { hash, hmac, randomToken, safeEqual } from './crypto';
export function isLocal(c: AppContext): boolean {
  const host = new URL(c.req.url).hostname;
  return c.env.ENVIRONMENT === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(host);
}
export function cookieName(c: AppContext, name: string): string {
  return isLocal(c) ? `dev-${name}` : `__Host-${name}`;
}
export function cookie(c: AppContext, name: string): string | undefined {
  return getCookie(c, cookieName(c, name));
}
export function writeCookie(c: AppContext, name: string, token: string, seconds?: number): void {
  setCookie(c, cookieName(c, name), token, {
    httpOnly: true,
    secure: !isLocal(c),
    sameSite: 'Strict',
    path: '/',
    maxAge: seconds,
  });
}
export function clearCookie(c: AppContext, name: string): void {
  deleteCookie(c, cookieName(c, name), { path: '/', secure: !isLocal(c), sameSite: 'Strict' });
}
async function csrfBinding(c: AppContext): Promise<string> {
  return hash(['td', 'ps', 'da'].map((n) => cookie(c, n) || '').join('|'));
}
export async function csrfToken(c: AppContext): Promise<string> {
  let seed = cookie(c, 'csrf');
  if (!seed || !/^[A-Za-z0-9_-]{43}$/.test(seed)) {
    seed = randomToken();
    writeCookie(c, 'csrf', seed, 1800);
  }
  const expires = Date.now() + 1800_000;
  const body = `${expires}.${await csrfBinding(c)}`;
  return `${body}.${await hmac(c.env.CSRF_SECRET, `${seed}.${body}`)}`;
}
export async function requireBrowserMutation(c: AppContext): Promise<void> {
  const origin = c.req.header('Origin');
  let allowed = origin === c.env.APP_ORIGIN;
  if (isLocal(c) && origin) {
    try {
      allowed = ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
    } catch {
      allowed = false;
    }
  }
  if (!allowed) fail(403, 'ORIGIN_REJECTED', '요청 출처를 확인할 수 없습니다.');
  if (!c.req.header('Content-Type')?.startsWith('application/json'))
    fail(415, 'INVALID_CONTENT_TYPE', 'JSON 요청이 필요합니다.');
  const token = c.req.header('X-CSRF-Token') || '',
    seed = cookie(c, 'csrf');
  const [expires, binding, signature] = token.split('.');
  if (
    !seed ||
    !signature ||
    !Number.isFinite(Number(expires)) ||
    Number(expires) <= Date.now() ||
    Number(expires) > Date.now() + 1800_000 ||
    binding !== (await csrfBinding(c))
  )
    fail(403, 'CSRF_REJECTED', '요청을 확인할 수 없습니다. 화면을 새로고침해 주세요.');
  const expected = await hmac(c.env.CSRF_SECRET, `${seed}.${expires}.${binding}`);
  if (!safeEqual(expected, signature)) fail(403, 'CSRF_REJECTED', '요청을 확인할 수 없습니다.');
}
export async function json<T>(c: AppContext, schema: ZodType<T>): Promise<T> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail(400, 'INVALID_INPUT', '입력 내용이 없습니다.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) {
      await reader.cancel();
      fail(413, 'REQUEST_TOO_LARGE', '요청 내용이 너무 큽니다.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(400, 'INVALID_INPUT', '올바른 JSON이 필요합니다.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) fail(400, 'INVALID_INPUT', '입력 내용을 확인해 주세요.');
  return result.data;
}
