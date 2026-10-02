import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { Secret } from 'otpauth';
if (existsSync('.dev.vars')) {
  console.log('Local secrets already exist; preserved. Run npm run code to view the current code.');
  process.exit(0);
}
const secret = new Secret({ size: 20 }).base32;
const pin = String(randomBytes(4).readUInt32BE() % 10000).padStart(4, '0');
const key = () => randomBytes(32).toString('base64url');
writeFileSync(
  '.dev.vars',
  [
    `TOTP_SECRET=${secret}`,
    `DOWNLOAD_PIN=${pin}`,
    `CSRF_SECRET=${key()}`,
    `IP_HASH_SECRET=${key()}`,
    `IDEMPOTENCY_SECRET=${key()}`,
    'R2_ACCESS_KEY_ID=',
    'R2_SECRET_ACCESS_KEY=',
    'STAGING_GATE_SECRET=',
  ].join('\n') + '\n',
  { mode: 0o600 },
);
writeFileSync(
  'local-access.json',
  JSON.stringify(
    {
      note: 'Local development only. Do not use these credentials in production.',
      downloadPin: pin,
      totpSecret: secret,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  'Created private local credentials. Run npm run code to view the current TOTP and local PIN.',
);
