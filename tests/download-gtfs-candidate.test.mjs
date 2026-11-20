import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { acquireGtfs, validateDownloadPolicy, validateRedirect } from '../scripts/download-gtfs-candidate.mjs';

const primary = 'https://dati.comune.milano.it/gtfs.zip';
const alternative = 'https://dati.comune.milano.it/dataset/ae3f3db9-de61-45b7-94e7-9395c0e3ef53/resource/6251f156-4c74-4a0b-904e-01bcb701a686/download/gtfs.zip';
const policy = (overrides = {}) => ({
  maximumAttemptsPerUrl: 2,
  connectTimeoutSeconds: 8,
  attemptTimeoutSeconds: 45,
  retryDelaySeconds: 2,
  totalBudgetSeconds: 145,
  maximumBytes: 60_000_000,
  maximumRedirects: 2,
  allowedHosts: ['dati.comune.milano.it'],
  urls: [
    { id: 'primary', url: primary, enabled: true },
    { id: 'catalog-resource', url: alternative, enabled: false },
  ],
  ...overrides,
});

const outcome = (value, extra = {}) => async ({ url }) => ({ outcome: value, status: value === 'HTTP_502' ? 502 : null, bytes: 0, finalUrl: url, durationMs: 1, ...extra });

test('accepts a primary download and records its exact source', async () => {
  const buffer = Buffer.from('valid candidate');
  const result = await acquireGtfs({ policy: policy(), attempt: outcome('SUCCESS', { status: 200, bytes: buffer.length, buffer }), sleep: async () => {} });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.selected.sourceId, 'primary');
  assert.equal(result.selected.finalUrl, primary);
  assert.deepEqual(result.buffer, buffer);
});

for (const [label, failed, expectedAttempts] of [
  ['timeout', { outcome: 'TIMEOUT', status: null }, 2],
  ['HTTP 502', { outcome: 'HTTP_5XX', status: 502 }, 2],
  ['HTTP 404', { outcome: 'HTTP_4XX', status: 404 }, 1],
]) test(`classifies primary ${label} with bounded retries`, async () => {
  const result = await acquireGtfs({ policy: policy(), attempt: async ({ url }) => ({ ...failed, bytes: 0, finalUrl: url, durationMs: 1 }), sleep: async () => {} });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.attempts.length, expectedAttempts);
  assert.equal(result.failure, failed.outcome);
});

test('uses a qualified enabled alternative only after the primary fails', async () => {
  const buffer = Buffer.from('fallback candidate');
  const urls = policy().urls.map((entry) => ({ ...entry, enabled: true }));
  const result = await acquireGtfs({
    policy: policy({ urls }), sleep: async () => {},
    attempt: async ({ source, url }) => source.id === 'primary'
      ? { outcome: 'TIMEOUT', status: null, bytes: 0, finalUrl: url }
      : { outcome: 'SUCCESS', status: 200, bytes: buffer.length, finalUrl: url, buffer },
  });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.selected.sourceId, 'catalog-resource');
  assert.equal(result.attempts.filter((entry) => entry.sourceId === 'primary').length, 2);
});

test('rejects a configured alternative outside the explicit allowlist', () => {
  const urls = [...policy().urls, { id: 'external', url: 'https://example.test/gtfs.zip', enabled: true }];
  assert.throws(() => validateDownloadPolicy(policy({ urls })), /not allowlisted/);
});

test('rejects redirects to unauthorized hosts', () => {
  assert.throws(() => validateRedirect(primary, 'https://cdn.example.test/gtfs.zip', ['dati.comune.milano.it']), /REDIRECT_UNAUTHORIZED/);
  assert.throws(() => validateRedirect(primary, 'https://dati.comune.milano.it:444/gtfs.zip', ['dati.comune.milano.it']), /REDIRECT_UNAUTHORIZED/);
});

test('production policy enables only the qualified official primary', () => {
  const monitor = JSON.parse(readFileSync(new URL('../territories/milano-test/monitor.json', import.meta.url), 'utf8'));
  const checked = validateDownloadPolicy(monitor.gtfs.download);
  assert.deepEqual(checked.urls.filter((entry) => entry.enabled).map((entry) => entry.url), [primary]);
  assert.equal(checked.urls.find((entry) => entry.id === 'catalog-resource').enabled, false);
});

test('reports both enabled paths unavailable without unlimited retries', async () => {
  const urls = policy().urls.map((entry) => ({ ...entry, enabled: true }));
  const result = await acquireGtfs({ policy: policy({ urls }), attempt: outcome('NETWORK'), sleep: async () => {} });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.attempts.length, 4);
});

test('stops when the explicit total budget is exhausted', async () => {
  let now = 0;
  const clock = { now: () => now };
  const result = await acquireGtfs({
    policy: policy({ totalBudgetSeconds: 10 }), clock,
    attempt: async ({ url }) => { now += 10_000; return { outcome: 'TIMEOUT', bytes: 0, finalUrl: url }; },
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.failure, 'BUDGET_EXHAUSTED');
  assert.equal(result.attempts.length, 1);
});

test('classifies an incomplete body and never accepts it', async () => {
  const result = await acquireGtfs({ policy: policy(), attempt: outcome('INCOMPLETE', { status: 200, bytes: 123 }), sleep: async () => {} });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.failure, 'INCOMPLETE');
  assert.equal(result.attempts.length, 2);
});

test('workflows use the bounded downloader and do not perform unauthorized publication', () => {
  const monitor = readFileSync(new URL('../.github/workflows/monitor-sources.yml', import.meta.url), 'utf8');
  const promote = readFileSync(new URL('../.github/workflows/promote-gtfs.yml', import.meta.url), 'utf8');
  assert.match(monitor, /download-gtfs-candidate\.mjs/);
  assert.match(promote, /download-gtfs-candidate\.mjs/);
  assert.doesNotMatch(monitor, /curl -fsSL/);
  assert.doesNotMatch(monitor, /contents: write|pull-requests: write/);
  assert.match(promote, /if: needs\.validate\.outputs\.promote == 'true'/);
});
