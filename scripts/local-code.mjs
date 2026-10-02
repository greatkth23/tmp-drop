import { readFileSync } from 'node:fs';
import { TOTP } from 'otpauth';
const values = JSON.parse(readFileSync('local-access.json', 'utf8'));
const totp = new TOTP({ secret: values.totpSecret, algorithm: 'SHA1', digits: 6, period: 30 });
console.log('Local development only');
console.log('Current Authenticator code:', totp.generate());
console.log('Seconds until next code:', 30 - (Math.floor(Date.now() / 1000) % 30));
console.log('Download PIN:', values.downloadPin);
