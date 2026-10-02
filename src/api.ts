import type { AuthStatus } from '../shared/contracts';
let csrf = '';
export class ApiFailure extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public retryAfterSeconds = 0,
    public status = 0,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
    headers.set('X-CSRF-Token', csrf);
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      signal: options.signal || AbortSignal.timeout(60_000),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiFailure('NETWORK_ERROR', '인터넷 연결을 확인해 주세요.', true);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new ApiFailure(
      'INVALID_RESPONSE',
      '서버 응답을 확인하고 있습니다.',
      response.status >= 500,
      Number(response.headers.get('Retry-After')) || 0,
      response.status,
    );
  }
  if (!response.ok) {
    const e = result.error;
    throw new ApiFailure(
      e?.code || 'REQUEST_FAILED',
      e?.message || '요청을 처리하지 못했습니다.',
      e?.retryable || response.status >= 500,
      e?.retryAfterSeconds || 0,
      response.status,
    );
  }
  return result as T;
}
export function mutate<T>(
  path: string,
  body: unknown = {},
  method = 'POST',
  extra: Record<string, string> = {},
): Promise<T> {
  return api<T>(path, { method, body: JSON.stringify(body), headers: extra });
}
export async function authStatus(): Promise<AuthStatus> {
  const result = await api<AuthStatus>('/api/auth/status');
  csrf = result.csrfToken;
  return result;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
}
