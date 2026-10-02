import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { TOTP } from 'otpauth';
import { AwsClient } from 'aws4fetch';
const secretPath = process.argv[2];
if (!secretPath) throw new Error('Usage: node scripts/smoke-staging.mjs <private-secrets.json>');
const secrets = JSON.parse(await readFile(secretPath, 'utf8'));
const origin = 'https://personal-temporary-drop-staging.rmarkfcl.workers.dev';
const account = '37111ae2b9e9e205a1a920baa30108d8',
  bucket = 'temporary-drop-staging';
const cookies = new Map();
let csrf = '',
  lastStep = -1;
const evidence = { version: '0.2.0', origin, startedAt: new Date().toISOString(), checks: [] };
function passed(name, detail = {}) {
  evidence.checks.push({ name, ...detail });
  console.log(JSON.stringify({ passed: name, ...detail }));
}
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
async function request(path, method = 'GET', body, extra = {}, allowError = false) {
  const headers = new Headers({
    'X-Staging-Token': secrets.STAGING_GATE_SECRET,
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
  const res = await fetch(origin + path, {
    method,
    headers,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(180_000),
  });
  for (const value of res.headers.getSetCookie()) {
    const pair = value.split(';')[0],
      i = pair.indexOf('=');
    if (pair.slice(i + 1)) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    else cookies.delete(pair.slice(0, i));
    assert(
      value.includes('Secure') && value.includes('HttpOnly') && value.includes('SameSite=Strict'),
      'Remote cookie security attributes missing',
    );
  }
  if (!allowError && res.status >= 400) {
    const value = await res.json().catch(() => null);
    throw new Error(`${method} ${path}: ${res.status} ${value?.error?.code || ''}`);
  }
  return res;
}
async function status() {
  const s = await (await request('/api/auth/status')).json();
  csrf = s.csrfToken;
  return s;
}
async function otp(intent, extra = {}) {
  const step = Math.floor(Date.now() / 30_000);
  if (step <= lastStep) {
    console.log('Waiting for the next TOTP window.');
    await new Promise((r) => setTimeout(r, (lastStep + 1) * 30_000 - Date.now() + 200));
  }
  lastStep = Math.floor(Date.now() / 30_000);
  const res = await request(
    '/api/auth/totp',
    'POST',
    { code: new TOTP({ secret: secrets.TOTP_SECRET }).generate(), intent, ...extra },
    {},
    true,
  );
  if (res.status !== 200) {
    const value = await res.json();
    if (value.error?.code === 'TOTP_REPLAY') return otp(intent, extra);
    throw new Error(`TOTP ${value.error?.code}`);
  }
  return res.json();
}
async function signed(key, method, ttl = 300, headers = {}) {
  const url = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${key}`);
  url.searchParams.set('X-Amz-Expires', String(ttl));
  return new AwsClient({
    accessKeyId: secrets.R2_ACCESS_KEY_ID,
    secretAccessKey: secrets.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
    retries: 0,
  }).sign(url, { method, headers, aws: { signQuery: true } });
}
async function redirectedDownload(id, range) {
  const response = await request(`/api/files/${id}/download`);
  assert(response.status === 302, 'Signed redirect missing');
  const url = new URL(response.headers.get('Location'));
  assert(url.hostname === `${account}.r2.cloudflarestorage.com`, 'Unexpected download destination');
  return fetch(url, {
    headers: range ? { Range: range } : {},
    signal: AbortSignal.timeout(180_000),
  });
}
for (const path of ['/api/health', '/upload', '/assets/index-Q9SHRppj.js'])
  assert((await fetch(origin + path)).status === 404, 'Staging gate bypassed');
passed('staging gate denies API, page and static assets');
assert(
  (await (await request('/api/health')).json()).version === '0.2.0',
  'Unexpected deployed version',
);
await status();
await otp('upload');
await status();
passed('remote TOTP login and Secure HttpOnly Strict cookies');
const part = Buffer.alloc(64 * 1024 ** 2, 0x5a),
  last = Buffer.from([0xa5]);
const u = await (
  await request(
    '/api/uploads',
    'POST',
    {
      filename: '실제 R2 무결성 64MiB+1.bin',
      sizeBytes: part.length + 1,
      mime: 'application/octet-stream',
      retentionSeconds: 3600,
    },
    { 'Idempotency-Key': randomUUID() },
  )
).json();
const auth = { Authorization: `Upload ${u.capability}` };
const start = performance.now();
await Promise.all([
  request(`/api/uploads/${u.id}/parts/1`, 'PUT', part, auth),
  request(`/api/uploads/${u.id}/parts/2`, 'PUT', last, auth),
]);
assert(
  (await (await request(`/api/uploads/${u.id}/complete`, 'POST', {}, auth)).json()).state ===
    'READY',
  'Multipart not READY',
);
passed('remote 64MiB+1 multipart, ListParts manifest and finalize', {
  fileId: u.id,
  bytes: part.length + 1,
  uploadSeconds: Math.round((performance.now() - start) / 100) / 10,
});
await request('/api/download/unlock', 'POST', { pin: secrets.DOWNLOAD_PIN, remember: false });
await status();
const download = await redirectedDownload(u.id);
assert(download.ok, 'Signed download failed');
assert(
  download.headers.get('Content-Disposition')?.includes("filename*=UTF-8''"),
  'UTF-8 attachment missing',
);
const digest = createHash('sha256');
let bytes = 0;
for await (const chunk of download.body) {
  bytes += chunk.length;
  digest.update(chunk);
}
const actual = digest.digest('hex'),
  expected = createHash('sha256').update(part).update(last).digest('hex');
assert(bytes === part.length + 1 && actual === expected, 'Multipart SHA-256 mismatch');
passed('signed GET full SHA-256 and Korean attachment', { sha256: actual, bytes });
const ranged = await redirectedDownload(u.id, `bytes=${part.length - 1}-${part.length}`);
assert(ranged.status === 206, 'Range not 206');
assert(
  Buffer.from(await ranged.arrayBuffer()).equals(Buffer.from([0x5a, 0xa5])),
  'Cross-part Range mismatch',
);
passed('signed GET Range across part boundary');
const expiry = await signed(`final/${u.id}`, 'GET', 1);
await new Promise((r) => setTimeout(r, 2200));
assert((await fetch(expiry.url)).status === 403, 'Expired signed URL accepted');
passed('expired S3 signed GET rejected');
const deviceGrant = await otp('create_device');
const device = await (
  await request(
    '/api/devices',
    'POST',
    { name: 'staging-smoke-shortcut', kind: 'shortcut' },
    { 'X-Admin-Grant': deviceGrant.grant },
  )
).json();
const shortcutBody = Buffer.from('Real R2 shortcut copy integrity — 한글');
const shortcut = await (
  await request(
    '/api/shortcut/uploads',
    'POST',
    {
      filename: '단축어.txt',
      sizeBytes: shortcutBody.length,
      mime: 'text/plain',
      retentionSeconds: 3600,
    },
    { Authorization: `Bearer ${device.token}`, 'Idempotency-Key': randomUUID() },
  )
).json();
const put = await fetch(shortcut.putUrl, {
  method: 'PUT',
  body: shortcutBody,
  headers: shortcut.putHeaders,
});
assert(put.ok, 'Shortcut signed PUT failed');
const shortcutAuth = { Authorization: `Upload ${shortcut.capability}` };
assert(
  (await (await request(`/api/uploads/${shortcut.id}/complete`, 'POST', {}, shortcutAuth)).json())
    .state === 'READY',
  'Shortcut copy not READY',
);
const sDownload = await redirectedDownload(shortcut.id);
assert(
  Buffer.from(await sDownload.arrayBuffer()).equals(shortcutBody),
  'Shortcut final copy mismatch',
);
// A still-valid staging PUT cannot change the final object after conditional promotion.
assert(
  (await fetch(shortcut.putUrl, { method: 'PUT', body: Buffer.alloc(shortcutBody.length, 0x78) }))
    .ok,
  'Staging overwrite failed',
);
assert(
  Buffer.from(await (await redirectedDownload(shortcut.id)).arrayBuffer()).equals(shortcutBody),
  'Final changed after staging overwrite',
);
passed('shortcut signed PUT and conditional CopyObject preserve final bytes', {
  fileId: shortcut.id,
  bytes: shortcutBody.length,
  sha256: createHash('sha256').update(shortcutBody).digest('hex'),
});
// Direct S3 negative precondition test using only temporary smoke keys.
const client = new AwsClient({
  accessKeyId: secrets.R2_ACCESS_KEY_ID,
  secretAccessKey: secrets.R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
  retries: 0,
});
const prefix = `https://${account}.r2.cloudflarestorage.com/${bucket}/`,
  source = `smoke/${randomUUID()}/source`,
  target = source.replace('/source', '/copy');
try {
  assert(
    (await client.fetch(prefix + source, { method: 'PUT', body: 'one' })).ok,
    'S3 test source PUT failed',
  );
  const head = await client.fetch(prefix + source, { method: 'HEAD' }),
    etag = head.headers.get('ETag');
  assert(
    (await client.fetch(prefix + source, { method: 'PUT', body: 'two' })).ok,
    'S3 test source overwrite failed',
  );
  const copy = await client.fetch(prefix + target, {
    method: 'PUT',
    headers: { 'x-amz-copy-source': `/${bucket}/${source}`, 'x-amz-copy-source-if-match': etag },
  });
  assert(copy.status === 412, 'Changed source must fail CopyObject precondition');
  passed('CopyObject source ETag race rejected with 412');
} finally {
  await client.fetch(prefix + source, { method: 'DELETE' });
  await client.fetch(prefix + target, { method: 'DELETE' });
}
const reportGrant = await otp('maintenance_report');
const report = await (
  await request(
    '/api/maintenance/reconcile',
    'POST',
    { mode: 'report' },
    { 'X-Admin-Grant': reportGrant.grant },
  )
).json();
assert(
  report.quotaAfter.reserved === report.quotaAfter.expectedReserved &&
    report.quotaAfter.ready === report.quotaAfter.expectedReady,
  'Remote quota drift',
);
assert(
  !report.missingReadyObjects.length && !report.sizeMismatches.length,
  'Remote final object mismatch',
);
passed('remote reconciliation finds matching quota and READY object metadata', {
  reportId: report.id,
  scanned: report.scanned,
  readyBytes: report.quotaAfter.ready,
});
const revoke = await otp('revoke_device', { targetId: device.id });
await request(`/api/devices/${device.id}`, 'DELETE', {}, { 'X-Admin-Grant': revoke.grant });
assert(
  (
    await request(
      '/api/shortcut/uploads',
      'POST',
      { filename: 'revoked', sizeBytes: 1, retentionSeconds: 3600 },
      { Authorization: `Bearer ${device.token}`, 'Idempotency-Key': randomUUID() },
      true,
    )
  ).status === 403,
  'Revoked shortcut bearer accepted',
);
passed('revoked shortcut token rejected');
evidence.finishedAt = new Date().toISOString();
await writeFile(
  new URL('../../../work/staging-smoke-result.json', import.meta.url),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log('Staging smoke completed; evidence saved without credentials or signed URLs.');
