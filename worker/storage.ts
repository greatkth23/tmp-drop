import { AwsClient } from 'aws4fetch';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { FileRow, AppContext } from './types';
import { isLocal } from './http';
import { ApiError } from './errors';
import { disposition } from '../shared/contracts';
export function objectMetadata(file: FileRow): R2PutOptions {
  return {
    httpMetadata: {
      contentType: 'application/octet-stream',
      contentDisposition: disposition(file.filename),
      cacheControl: 'no-store',
    },
    customMetadata: { fileId: file.id },
  };
}
function signer(env: Env): AwsClient {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY)
    throw new ApiError(503, 'SIGNING_NOT_CONFIGURED', '직접 전송 설정이 아직 준비되지 않았습니다.');
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
    retries: 0,
  });
}
function urlFor(env: Env, key: string): URL {
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key.split('/').map(encodeURIComponent).join('/')}`,
  );
}
export function canListParts(env: Env): boolean {
  return !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}
export interface StoredPart {
  partNumber: number;
  bytes: number;
  etag: string;
}
export function decodeParts(
  xml: string,
  key: string,
  uploadId: string,
  marker: number,
  limit: number,
): {
  parts: StoredPart[];
  nextMarker: number | null;
} {
  const invalid = () =>
    new ApiError(502, 'INVALID_STORAGE_RESPONSE', '저장소 전송 목록을 확인할 수 없습니다.', true);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw invalid();
  const value = new XMLParser({
    parseTagValue: false,
    removeNSPrefix: true,
    isArray: (name) => name === 'Part',
  }).parse(xml);
  const root = value.ListPartsResult;
  if (
    !root ||
    root.Key !== key ||
    root.UploadId !== uploadId ||
    !['true', 'false'].includes(root.IsTruncated)
  )
    throw invalid();
  const raw = root.Part || [];
  if (!Array.isArray(raw) || raw.length > limit) throw invalid();
  let previous = marker;
  const parts = raw.map((p): StoredPart => {
    const partNumber = Number(p.PartNumber),
      bytes = Number(p.Size);
    const etag = typeof p.ETag === 'string' ? p.ETag.replace(/^"|"$/g, '') : '';
    if (
      !Number.isSafeInteger(partNumber) ||
      partNumber <= previous ||
      partNumber > 10_000 ||
      !/^\d+$/.test(p.Size || '') ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      !etag ||
      etag.length > 256 ||
      /[\x00-\x1f\x7f]/.test(etag)
    )
      throw invalid();
    previous = partNumber;
    return { partNumber, bytes, etag };
  });
  const nextMarker = root.IsTruncated === 'true' ? Number(root.NextPartNumberMarker) : null;
  if (
    nextMarker !== null &&
    (!parts.length ||
      !Number.isSafeInteger(nextMarker) ||
      nextMarker !== previous ||
      nextMarker <= marker)
  )
    throw invalid();
  return { parts, nextMarker };
}
export async function listParts(
  env: Env,
  key: string,
  uploadId: string,
  marker = 0,
  limit = 100,
): Promise<{ parts: StoredPart[]; nextMarker: number | null }> {
  const url = urlFor(env, key);
  url.searchParams.set('uploadId', uploadId);
  url.searchParams.set('part-number-marker', String(marker));
  url.searchParams.set('max-parts', String(limit));
  const response = await signer(env).fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  });
  const xml = await boundedText(response, 262_144);
  if (response.status === 404 && /<Code>NoSuchUpload<\/Code>/.test(xml))
    throw new ApiError(409, 'MULTIPART_MISSING', '저장소의 전송 세션이 종료되었습니다.');
  if (!response.ok)
    throw new ApiError(
      503,
      'STORAGE_LOOKUP_FAILED',
      '저장소의 전송 결과를 확인하고 있습니다.',
      true,
      3,
    );
  return decodeParts(xml, key, uploadId, marker, limit);
}
export async function verifyManifest(
  env: Env,
  key: string,
  uploadId: string,
  expected: StoredPart[],
): Promise<void> {
  let marker = 0,
    count = 0;
  for (let page = 0; page < 6; page++) {
    const actual = await listParts(env, key, uploadId, marker);
    for (const part of actual.parts) {
      const wanted = expected[count++];
      if (
        !wanted ||
        wanted.partNumber !== part.partNumber ||
        wanted.bytes !== part.bytes ||
        wanted.etag.replace(/^"|"$/g, '') !== part.etag
      )
        throw new ApiError(
          422,
          'MANIFEST_MISMATCH',
          '저장소의 파일 부분이 전송 기록과 일치하지 않습니다.',
        );
    }
    if (actual.nextMarker === null) {
      if (count !== expected.length)
        throw new ApiError(
          422,
          'MANIFEST_MISMATCH',
          '저장소의 파일 부분이 전송 기록과 일치하지 않습니다.',
        );
      return;
    }
    marker = actual.nextMarker;
  }
  throw new ApiError(502, 'INVALID_STORAGE_RESPONSE', '저장소 전송 목록의 한도를 초과했습니다.');
}
export async function presign(
  env: Env,
  key: string,
  method: 'GET' | 'PUT',
  ttl: number,
): Promise<string> {
  const url = urlFor(env, key);
  url.searchParams.set('X-Amz-Expires', String(ttl));
  const signed = await signer(env).sign(url, { method, aws: { signQuery: true } });
  return signed.url;
}
export async function promote(c: AppContext, file: FileRow, etag: string): Promise<void> {
  if (!file.staging_key)
    throw new ApiError(500, 'INVALID_STATE', '전송 상태를 확인할 수 없습니다.');
  if (isLocal(c)) {
    const object = await c.env.BUCKET.get(file.staging_key, { onlyIf: { etagMatches: etag } });
    if (!object || !('body' in object))
      throw new ApiError(409, 'SOURCE_CHANGED', '전송한 파일이 변경되었습니다.');
    await c.env.BUCKET.put(file.final_key, object.body, objectMetadata(file));
    return;
  }
  const response = await signer(c.env).fetch(urlFor(c.env, file.final_key), {
    method: 'PUT',
    headers: {
      'x-amz-copy-source': `/${c.env.R2_BUCKET_NAME}/${file.staging_key.split('/').map(encodeURIComponent).join('/')}`,
      'x-amz-copy-source-if-match': `"${etag.replace(/^"|"$/g, '')}"`,
      'x-amz-metadata-directive': 'REPLACE',
      'x-amz-meta-fileid': file.id,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': disposition(file.filename),
      'Cache-Control': 'no-store',
    },
    signal: AbortSignal.timeout(60_000),
  });
  // CopyObject may return an embedded XML Error with HTTP 200. Bound the metadata body.
  const text = await boundedText(response, 65_536);
  if (!response.ok || !text.includes('<CopyObjectResult') || text.includes('<Error>'))
    throw new ApiError(
      503,
      'COPY_FAILED',
      '파일 확정을 완료하지 못했습니다. 다시 확인해 주세요.',
      true,
    );
}
export async function boundedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '',
    size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new ApiError(502, 'INVALID_STORAGE_RESPONSE', '저장소 응답을 확인할 수 없습니다.');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
export async function pipeExact(
  input: ReadableStream<Uint8Array>,
  expected: number,
  consume: (stream: ReadableStream) => Promise<unknown>,
): Promise<void> {
  const fixed = new FixedLengthStream(expected);
  const abort = new AbortController();
  const upload = consume(fixed.readable).catch((error) => {
    abort.abort(error);
    throw error;
  });
  // Await both: fixed length rejects under/oversized streams without buffering the file.
  const pipe = input.pipeTo(fixed.writable, { signal: abort.signal });
  const results = await Promise.allSettled([upload, pipe]);
  const failure = results.find((r) => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
