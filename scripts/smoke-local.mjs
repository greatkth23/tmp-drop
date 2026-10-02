import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { TOTP } from 'otpauth';
const origin = 'http://localhost:8787';
const access = JSON.parse(await readFile(new URL('../local-access.json', import.meta.url), 'utf8'));
const cookies = new Map();
let csrf = '';
async function request(path, method = 'GET', body, extra = {}) {
  const headers = new Headers({
    Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    ...extra,
  });
  let payload;
  if (body instanceof Uint8Array) {
    payload = body;
    headers.set('Content-Type', 'application/octet-stream');
  } else if (method !== 'GET') {
    payload = JSON.stringify(body || {});
    headers.set('Content-Type', 'application/json');
    headers.set('Origin', origin);
    headers.set('X-CSRF-Token', csrf);
  }
  const response = await fetch(origin + path, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(120_000),
  });
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';')[0],
      i = pair.indexOf('=');
    const key = pair.slice(0, i),
      token = pair.slice(i + 1);
    if (token) cookies.set(key, token);
    else cookies.delete(key);
  }
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new Error(`${method} ${path}: ${response.status} ${value?.error?.code || ''}`);
  }
  return response;
}
async function status() {
  const value = await (await request('/api/auth/status')).json();
  csrf = value.csrfToken;
}
await status();
const code = new TOTP({ secret: access.totpSecret }).generate();
await request('/api/auth/totp', 'POST', { code, intent: 'upload' });
await status();
const partSize = 64 * 1024 ** 2,
  part = Buffer.alloc(partSize, 0x5a),
  last = Buffer.from([0xa5]);
const upload = await (
  await request(
    '/api/uploads',
    'POST',
    {
      filename: 'smoke-multipart-64MiB-plus-1.bin',
      sizeBytes: partSize + 1,
      mime: 'application/octet-stream',
      retentionSeconds: 3600,
    },
    { 'Idempotency-Key': randomUUID() },
  )
).json();
const auth = { Authorization: `Upload ${upload.capability}` };
await Promise.all([
  request(`/api/uploads/${upload.id}/parts/1`, 'PUT', part, auth),
  request(`/api/uploads/${upload.id}/parts/2`, 'PUT', last, auth),
]);
const completed = await (
  await request(`/api/uploads/${upload.id}/complete`, 'POST', {}, auth)
).json();
if (completed.state !== 'READY') throw new Error('File did not reach READY');
await request('/api/download/unlock', 'POST', { pin: access.downloadPin, remember: false });
await status();
const downloaded = await request(`/api/files/${upload.id}/download`),
  actualHash = createHash('sha256');
let bytes = 0;
for await (const chunk of downloaded.body) {
  bytes += chunk.byteLength;
  actualHash.update(chunk);
}
const actual = actualHash.digest('hex'),
  expected = createHash('sha256').update(part).update(last).digest('hex');
if (bytes !== partSize + 1 || actual !== expected)
  throw new Error('Downloaded file integrity mismatch');
const range = await request(`/api/files/${upload.id}/download`, 'GET', undefined, {
  Range: `bytes=${partSize - 1}-${partSize}`,
});
const ranged = new Uint8Array(await range.arrayBuffer());
if (range.status !== 206 || ranged[0] !== 0x5a || ranged[1] !== 0xa5 || ranged.length !== 2)
  throw new Error('Boundary range mismatch');
await request('/api/auth/logout', 'POST', { scope: 'all' });
console.log(
  JSON.stringify(
    {
      ok: true,
      bytes,
      parts: 2,
      sha256: actual,
      range: 'passed',
      fileId: upload.id,
      note: 'Synthetic fixture expires after 1 hour.',
    },
    null,
    2,
  ),
);
