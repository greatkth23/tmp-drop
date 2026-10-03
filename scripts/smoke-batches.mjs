// Creates only disposable fixtures. Pass a private secrets JSON and private state path.
// seed: upload, verify grouping and ZIP; cleanup: delete only saved fixture IDs, verify isolation.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { TOTP } from 'otpauth';
import assert from 'node:assert/strict';
const [mode, origin, secretsPath, statePath] = process.argv.slice(2);
if (!['seed', 'cleanup'].includes(mode) || !statePath)
  throw Error('mode origin secretsPath statePath required');
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
const state =
  mode === 'cleanup' ? JSON.parse(await readFile(statePath, 'utf8')) : { ids: [], cookies: [] };
const cookies = new Map(state.cookies);
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
  const r = await fetch(origin + path, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(120000),
  });
  for (const value of r.headers.getSetCookie()) {
    const [key, ...v] = value.split(';')[0].split('=');
    if (v.join('=')) cookies.set(key, v.join('='));
    else cookies.delete(key);
  }
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw Error(
      `${method} ${path.split('/').slice(0, 3).join('/')}: ${r.status} ${j?.error?.code}`,
    );
  }
  return r;
}
async function status() {
  const j = await (await request('/api/auth/status')).json();
  csrf = j.csrfToken;
  return j;
}
async function save() {
  state.cookies = [...cookies];
  await writeFile(statePath, JSON.stringify(state));
}
await status();
if (mode === 'seed') {
  state.totpStep = Math.floor(Date.now() / 30_000);
  await request('/api/auth/totp', 'POST', {
    intent: 'trust',
    code: new TOTP({ secret: secrets.TOTP_SECRET }).generate(),
    deviceName: 'Disposable batch verification',
  });
  await status();
  await request('/api/download/unlock', 'POST', { pin: secrets.DOWNLOAD_PIN });
  await status();
  await save();
  const key = randomUUID();
  const data = [
    Buffer.from('batch text fixture'),
    Buffer.alloc(2 * 1024 * 1024 + 1, 0x5a),
    Buffer.from('unselected fixture'),
  ];
  const names = ['묶음 검증.txt', '묶음 검증.bin', '개별 검증.txt'];
  state.expected = data.slice(0, 2).map((v, i) => ({
    name: names[i],
    bytes: v.length,
    sha256: createHash('sha256').update(v).digest('hex'),
  }));
  for (let i = 0; i < data.length; i++) {
    const u = await (
      await request(
        '/api/uploads',
        'POST',
        {
          filename: names[i],
          sizeBytes: data[i].length,
          mime: 'application/octet-stream',
          retentionSeconds: 3600,
          ...(i < 2 ? { batchKey: key } : {}),
        },
        { 'Idempotency-Key': randomUUID() },
      )
    ).json();
    state.ids.push(u.id);
    await save();
    const auth = { Authorization: 'Upload ' + u.capability };
    await request(`/api/uploads/${u.id}/parts/1`, 'PUT', data[i], auth);
    assert.equal(
      (await (await request(`/api/uploads/${u.id}/complete`, 'POST', {}, auth)).json()).state,
      'READY',
    );
  }
  const list = await (await request('/api/file-groups')).json();
  const rows = state.ids.map((id) => list.files.find((f) => f.id === id));
  assert.ok(rows[0].batchId);
  assert.equal(rows[0].batchId, rows[1].batchId);
  assert.equal(rows[2].batchId, null);
  const ticket = await (
    await request('/api/files/archive', 'POST', { ids: state.ids.slice(0, 2) })
  ).json();
  const zip = await request(ticket.url);
  const bytes = Buffer.from(await zip.arrayBuffer());
  await writeFile(statePath + '.zip', bytes);
  await save();
  console.log(
    JSON.stringify({
      ok: true,
      mode,
      files: 3,
      grouped: 2,
      zipBytes: bytes.length,
      fixtureIds: state.ids,
    }),
  );
} else {
  const selected = state.ids.slice(0, 2),
    remaining = state.ids.slice(2);
  if (selected.length) {
    const result = await (await request('/api/files/delete', 'POST', { ids: selected })).json();
    assert.ok(result.results.every((r) => r.state === 'DELETED'));
    const list = await (await request('/api/file-groups')).json();
    assert.ok(!list.files.some((f) => selected.includes(f.id)));
    assert.ok(remaining.every((id) => list.files.some((f) => f.id === id)));
  }
  if (remaining.length) {
    const result = await (await request('/api/files/delete', 'POST', { ids: remaining })).json();
    assert.ok(result.results.every((r) => r.state === 'DELETED'));
  }
  await request('/api/auth/logout', 'POST', { scope: 'all' });
  await status();
  const devices = await (await request('/api/devices')).json();
  const own = devices.devices.find((d) => d.current);
  assert.equal(own?.name, 'Disposable batch verification');
  if (state.totpStep === Math.floor(Date.now() / 30_000)) {
    await new Promise((resolve) => setTimeout(resolve, 30_050 - (Date.now() % 30_000)));
  }
  const approval = await (
    await request('/api/auth/totp', 'POST', {
      code: new TOTP({ secret: secrets.TOTP_SECRET }).generate(),
      intent: 'revoke_device',
      targetId: own.id,
    })
  ).json();
  await request(`/api/devices/${own.id}`, 'DELETE', {}, { 'X-Admin-Grant': approval.grant });
  state.cookies = [];
  state.cleaned = true;
  await writeFile(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ ok: true, mode, selectedOnly: true, cleaned: state.ids.length }));
}
