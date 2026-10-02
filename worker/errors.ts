import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from './types';
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public retryable = false,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export function fail(status: ContentfulStatusCode, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
export function errorResponse(error: Error, c: AppContext): Response {
  const known = error instanceof ApiError;
  if (!known)
    console.error(
      JSON.stringify({
        requestId: c.get('requestId'),
        code: 'INTERNAL_ERROR',
        route: c.req.routePath,
      }),
    );
  const e = known
    ? error
    : new ApiError(
        500,
        'INTERNAL_ERROR',
        '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        true,
      );
  if (e.retryAfterSeconds) c.header('Retry-After', String(e.retryAfterSeconds));
  return c.json(
    {
      error: {
        code: e.code,
        message: e.message,
        retryable: e.retryable,
        requestId: c.get('requestId'),
        retryAfterSeconds: e.retryAfterSeconds,
      },
    },
    e.status,
  );
}
