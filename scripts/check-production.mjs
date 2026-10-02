import { readFile } from 'node:fs/promises';
import { parse } from 'jsonc-parser';
const file = process.argv[2] || 'wrangler.production.jsonc';
let config;
try {
  const parseErrors = [];
  config = parse(await readFile(file, 'utf8'), parseErrors, { allowTrailingComma: true });
  if (parseErrors.length || !config || typeof config !== 'object')
    throw new Error('Invalid config');
} catch {
  console.error(
    'Create a valid JSONC production config from wrangler.production.example.jsonc first.',
  );
  process.exit(1);
}
const errors = [];
const require = (condition, message) => {
  if (!condition) errors.push(message);
};
const variables = config.vars || {};
require(variables.ENVIRONMENT === 'production', 'ENVIRONMENT must be production.');
let origin;
try {
  origin = new URL(variables.APP_ORIGIN);
} catch {
  errors.push('APP_ORIGIN must be a valid URL.');
}
if (origin) {
  require(origin.protocol === 'https:', 'APP_ORIGIN must use HTTPS.');
  require(origin.origin === variables.APP_ORIGIN, 'APP_ORIGIN must contain only scheme and host.');
  require(!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
    !origin.hostname.endsWith('example.com'), 'APP_ORIGIN must name the actual production domain.');
  if (origin.hostname.endsWith('.workers.dev')) {
    require(config.workers_dev === true, 'Enable workers_dev for the workers.dev origin.');
    require(origin.hostname.split('.').length === 4 &&
      origin.hostname.split('.')[0] ===
        config.name, 'workers.dev origin must match the Worker name and account subdomain.');
  } else {
    require(config.workers_dev === false, 'Disable workers_dev when using a custom domain.');
    require(config.routes?.some(
      (route) => route.custom_domain === true && route.pattern === origin.hostname,
    ), 'Custom domain must match APP_ORIGIN.');
  }
}
const db = config.d1_databases?.find((binding) => binding.binding === 'DB');
require(!!db &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db.database_id) &&
  !db.database_id.startsWith('00000000-'), 'Configure a real production D1 database UUID.');
const bucket = config.r2_buckets?.find((binding) => binding.binding === 'BUCKET');
require(!!bucket &&
  bucket.bucket_name === variables.R2_BUCKET_NAME, 'R2 binding and signing bucket must match.');
require(/^[0-9a-f]{32}$/i.test(
  variables.R2_ACCOUNT_ID || '',
), 'Configure the actual R2 account ID.');
require(config.assets?.run_worker_first?.includes(
  '/api/*',
), 'API paths must run through the Worker.');
require(config.triggers?.crons?.length > 0, 'Configure the cleanup schedule.');
if (errors.length) {
  errors.forEach((error) => console.error(error));
  process.exit(1);
}
console.log(
  'Production public configuration validated. Secrets, bucket privacy, lifecycle rules and release gates require separate verification.',
);
