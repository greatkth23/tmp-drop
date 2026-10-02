import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
          DOWNLOAD_PIN: '4827',
          CSRF_SECRET: 'test-only-csrf-not-for-production',
          IP_HASH_SECRET: 'test-only-ip-not-for-production',
          IDEMPOTENCY_SECRET: 'test-only-idempotency-not-for-production',
        },
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'], fileParallelism: false, testTimeout: 30_000 },
});
