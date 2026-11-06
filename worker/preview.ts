import type { AppContext, FileRow } from './types';
import { downloadSession } from './auth';
import { fail } from './errors';
import { IMAGE_PREVIEW_MAX_BYTES } from '../shared/preview';

function rasterType(bytes: Uint8Array): string | null {
  const text = new TextDecoder('ascii').decode(bytes);
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'image/gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  if (text.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(text.slice(8, 12)))
    return 'image/avif';
  return null;
}
export async function filePreview(c: AppContext) {
  const session = (await downloadSession(c))!;
  const file = await c.env.DB.prepare(
    "SELECT * FROM files WHERE id=? AND state='READY' AND expires_at>?",
  )
    .bind(c.req.param('id'), Date.now())
    .first<FileRow>();
  if (!file) fail(404, 'FILE_UNAVAILABLE', '파일이 없거나 보관 시간이 끝났습니다.');
  if (file.size_bytes > IMAGE_PREVIEW_MAX_BYTES)
    fail(415, 'PREVIEW_UNAVAILABLE', '미리보기를 지원하지 않는 파일입니다.');
  const prefix = await c.env.BUCKET.get(file.final_key, { range: { offset: 0, length: 32 } });
  if (!prefix || !('body' in prefix)) fail(404, 'FILE_UNAVAILABLE', '파일을 찾을 수 없습니다.');
  const mime = rasterType(new Uint8Array(await prefix.arrayBuffer()));
  if (!mime || prefix.size > IMAGE_PREVIEW_MAX_BYTES)
    fail(415, 'PREVIEW_UNAVAILABLE', '미리보기를 지원하지 않는 파일입니다.');
  if (file.expires_at! <= Date.now() || session.expires_at <= Date.now())
    fail(404, 'FILE_UNAVAILABLE', '파일의 보관 시간이 끝났습니다.');
  const object = await c.env.BUCKET.get(file.final_key, { onlyIf: { etagMatches: prefix.etag } });
  if (!object || !('body' in object)) fail(404, 'FILE_UNAVAILABLE', '파일을 찾을 수 없습니다.');
  return new Response(object.body, {
    headers: {
      'Content-Type': mime,
      'Content-Length': String(object.size),
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
