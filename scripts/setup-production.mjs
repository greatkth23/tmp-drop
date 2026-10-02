import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Secret, TOTP } from 'otpauth';

const directory = join(homedir(), '.codex', 'private', 'tmp-drop');
const secretPath = join(directory, 'production-secrets.json');
await mkdir(directory, { recursive: true, mode: 0o700 });
let secrets;
try {
  secrets = JSON.parse(await readFile(secretPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const key = () => randomBytes(32).toString('base64url');
  secrets = {
    TOTP_SECRET: new Secret({ size: 20 }).base32,
    DOWNLOAD_PIN: String(randomInt(10000)).padStart(4, '0'),
    CSRF_SECRET: key(),
    IP_HASH_SECRET: key(),
    IDEMPOTENCY_SECRET: key(),
  };
  await writeFile(secretPath, JSON.stringify(secrets, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
}
const totp = new TOTP({
  issuer: 'Temporary Drop',
  label: 'drop.rmarkfcl.workers.dev',
  secret: secrets.TOTP_SECRET,
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
});
const accessPath = join(directory, 'production-access.html');
await writeFile(
  accessPath,
  `<!doctype html>
<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Temporary Drop 운영 인증 등록</title>
<style>body{font:17px/1.7 system-ui;max-width:680px;margin:60px auto;padding:24px}code{word-break:break-all}button{padding:12px}input{width:100%;font:inherit;padding:10px;box-sizing:border-box}</style>
<h1>Temporary Drop 운영 인증 등록</h1>
<p>이 파일은 비밀 정보입니다. 공유하거나 GitHub에 올리지 마세요.</p>
<p>사이트: <a href="https://drop.rmarkfcl.workers.dev">drop.rmarkfcl.workers.dev</a></p>
<h2>파일 받기 PIN</h2><details><summary>PIN 표시</summary><code>${secrets.DOWNLOAD_PIN}</code></details>
<h2>파일 올리기 Authenticator</h2>
<p>Authenticator에서 계정을 수동으로 추가합니다. 이름은 Temporary Drop, 유형은 시간 기반, SHA-1 / 6자리 / 30초입니다.</p>
<details><summary>등록 키 표시</summary><input readonly value="${secrets.TOTP_SECRET}" aria-label="Authenticator 등록 키"><p><a href="${totp.toString()}">이 기기의 Authenticator로 등록</a></p></details>
<p>등록한 앱의 현재 6자리 코드를 업로드 화면에 입력하세요. 같은 코드는 한 번만 사용할 수 있습니다.</p>
<p>운영 비밀 원본은 같은 폴더의 production-secrets.json에 있습니다. 이 폴더는 저장소와 OneDrive 밖에 보관됩니다.</p></html>`,
  { mode: 0o600 },
);
console.log('Production credentials preserved or generated outside the repository.');
console.log(`Private secrets: ${secretPath}`);
console.log(`Private enrollment: ${accessPath}`);
