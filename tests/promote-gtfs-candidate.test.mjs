import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPromotionPlan, promoteCandidate } from '../scripts/promote-gtfs-candidate.mjs';

const repository = 'Moov3nt/helekh-otp-graph-build';
const baseSha = '1'.repeat(40);
const root = new URL('..', import.meta.url);
const sourcesText = readFileSync(new URL('territories/milano-test/sources.json', root), 'utf8');
const sources = JSON.parse(sourcesText);
const candidateBytes = Buffer.from('valid-gtfs-fixture-bytes');
const candidateSha = createHash('sha256').update(candidateBytes).digest('hex');

function candidateReport(overrides = {}) {
  const base = {
    schema: 'source-candidate-report-v1', territory: 'milano-test', source: 'gtfs', checkedAtUtc: '2026-11-20T12:00:00.000Z', state: 'UPDATED_VALID',
    acquisition: { status: 'AVAILABLE', publisherUrl: sources.gtfs.publisherUrl },
    current: { sha256: sources.gtfs.sha256, bytes: sources.gtfs.bytes, validUntil: sources.gtfs.validUntil },
    candidate: { sha256: candidateSha, bytes: candidateBytes.length, change: 'UPDATED' },
    integrity: { zip: 'PASS' }, license: { verdict: 'APPROVED', id: 'CC-BY-4.0' },
    validity: { verdict: 'PASS', trips: 150000, servicesWithTrips: 10, effective: { firstServiceDate: '2026-11-15', lastServiceDate: '2027-01-31' } },
    expiry: { lastServiceDate: '2027-01-31', daysRemaining: 72, warningLevelDays: null }, feedInfo: { version: '426' }, problems: [],
  };
  return {
    ...base, ...overrides,
    acquisition: { ...base.acquisition, ...(overrides.acquisition ?? {}) },
    current: { ...base.current, ...(overrides.current ?? {}) },
    candidate: { ...base.candidate, ...(overrides.candidate ?? {}) },
    integrity: { ...base.integrity, ...(overrides.integrity ?? {}) },
    license: { ...base.license, ...(overrides.license ?? {}) },
    validity: { ...base.validity, ...(overrides.validity ?? {}), effective: { ...base.validity.effective, ...(overrides.validity?.effective ?? {}) } },
    expiry: { ...base.expiry, ...(overrides.expiry ?? {}) },
  };
}

function mockApi(options = {}) {
  const calls = [];
  const uploads = [];
  const branches = [];
  const pulls = options.pulls ?? [];
  let release = options.release === undefined ? null : options.release;
  const assets = [...(options.assets ?? [])];
  return {
    calls, uploads, branches,
    async getRelease(tag) { calls.push(['getRelease', tag]); return release; },
    async createRelease(payload) {
      calls.push(['createRelease', payload]);
      if (options.releaseError) throw new Error('GitHub release failure');
      release = { id: 1, upload_url: 'https://uploads.example.test/assets{?name}', html_url: 'https://github.test/release' };
      return release;
    },
    async listReleaseAssets() { calls.push(['listAssets']); return assets; },
    async downloadAsset(id) { calls.push(['downloadAsset', id]); return options.downloads?.[id] ?? Buffer.alloc(0); },
    async uploadAsset(url, name, type, body) { calls.push(['uploadAsset', name]); uploads.push({ name, type, body }); return { id: uploads.length, name }; },
    async listOpenPulls() { calls.push(['listOpenPulls']); return pulls; },
    async getBranch(branch) { calls.push(['getBranch', branch]); return options.branch ?? null; },
    async getFile() { calls.push(['getFile']); return options.branchContent; },
    async createBranchCommit(payload) { calls.push(['createBranchCommit']); branches.push(payload); return { ref: payload.branch }; },
    async createPull(payload) {
      calls.push(['createPull', payload]);
      if (options.pullError) throw new Error('GitHub pull failure');
      return { html_url: 'https://github.test/pull/1' };
    },
  };
}

async function scenario(report = candidateReport(), api = mockApi()) {
  const directory = mkdtempSync(join(tmpdir(), 'helekh-promotion-test-'));
  const candidatePath = join(directory, 'candidate.zip');
  writeFileSync(candidatePath, candidateBytes);
  try {
    const result = await promoteCandidate({ report, sources, sourcesText, candidatePath, repository, baseSha, api });
    return { result, api };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('does nothing when the freshly downloaded feed is unchanged', async () => {
  const report = candidateReport({ candidate: { sha256: sources.gtfs.sha256, bytes: candidateBytes.length, change: 'UNCHANGED' } });
  const directory = mkdtempSync(join(tmpdir(), 'helekh-promotion-test-'));
  const path = join(directory, 'candidate.zip');
  const bytes = Buffer.from('current-content-placeholder');
  writeFileSync(path, bytes);
  report.candidate.sha256 = createHash('sha256').update(bytes).digest('hex');
  report.candidate.bytes = bytes.length;
  const currentSources = structuredClone(sources);
  currentSources.gtfs.sha256 = report.candidate.sha256;
  currentSources.gtfs.bytes = bytes.length;
  report.current.sha256 = report.candidate.sha256;
  report.current.bytes = bytes.length;
  const api = mockApi();
  try {
    const result = await promoteCandidate({ report, sources: currentSources, sourcesText: JSON.stringify(currentSources), candidatePath: path, repository, baseSha, api });
    assert.equal(result.action, 'UNCHANGED');
    assert.deepEqual(api.calls, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('publishes a new valid feed and prepares a PR changing only GTFS metadata', async () => {
  const { result, api } = await scenario();
  assert.equal(result.action, 'CREATED_ASSET_AND_PR');
  assert.equal(api.uploads.length, 2);
  assert.equal(api.branches.length, 1);
  assert.equal(api.calls.find(([name]) => name === 'createRelease')[1].target_commitish, baseSha);
  const updated = JSON.parse(api.branches[0].content);
  assert.equal(updated.gtfs.sha256, candidateSha);
  assert.equal(updated.gtfs.version, '426');
  assert.deepEqual(updated.osm, sources.osm);
});

test('blocks a candidate whose effective coverage regresses', async () => {
  const api = mockApi();
  const report = candidateReport({
    state: 'EXPIRING',
    validity: { effective: { lastServiceDate: '2026-11-29' } },
    expiry: { lastServiceDate: '2026-11-29', daysRemaining: 9, warningLevelDays: 14 },
  });
  await assert.rejects(scenario(report, api), /GTFS_TEMPORAL_REGRESSION.*2026-11-29.*2026-11-30/);
  assert.deepEqual(api.calls, []);
});

test('accepts a valid changed feed with the same effective final date', async () => {
  const report = candidateReport({
    state: 'EXPIRING',
    validity: { effective: { lastServiceDate: '2026-11-30' } },
    expiry: { lastServiceDate: '2026-11-30', daysRemaining: 10, warningLevelDays: 14 },
  });
  const { result } = await scenario(report);
  assert.equal(result.action, 'CREATED_ASSET_AND_PR');
});

test('accepts a valid changed feed with extended effective coverage', async () => {
  const { result } = await scenario(candidateReport());
  assert.equal(result.action, 'CREATED_ASSET_AND_PR');
});

for (const [name, overrides, error] of [
  ['blocks an expired feed', { state: 'EXPIRED', expiry: { daysRemaining: -1 }, validity: { verdict: 'FAIL' } }, 'GTFS_EXPIRED'],
  ['blocks a corrupt ZIP', { state: 'UPDATED_INVALID', integrity: { zip: 'FAIL' } }, 'ZIP_INVALID'],
  ['blocks an unknown licence', { state: 'LICENSE_UNKNOWN', license: { verdict: 'UNKNOWN' } }, 'LICENSE_NOT_APPROVED'],
  ['blocks a calendar without effective trips', { state: 'UPDATED_INVALID', validity: { verdict: 'FAIL', trips: 0, effective: { firstServiceDate: null, lastServiceDate: null } } }, 'GTFS_INVALID'],
  ['blocks a failed download', { state: 'UNAVAILABLE', acquisition: { status: 'UNAVAILABLE' }, candidate: { sha256: null, bytes: null, change: 'UNKNOWN' } }, 'SOURCE_UNAVAILABLE'],
]) test(name, async () => {
  const api = mockApi();
  await assert.rejects(scenario(candidateReport(overrides), api), new RegExp(error));
  assert.deepEqual(api.calls, []);
});

test('reuses an existing identical Release asset', async () => {
  const report = candidateReport();
  const plan = buildPromotionPlan({ report, sources, sourcesText, repository });
  const api = mockApi({
    release: { id: 1, upload_url: 'https://uploads.test/assets{?name}', html_url: 'https://github.test/release' },
    assets: [{ id: 10, name: plan.assetName, size: candidateBytes.length, digest: `sha256:${candidateSha}` }],
  });
  const { result } = await scenario(report, api);
  assert.equal(result.action, 'REUSED_ASSET_AND_CREATED_PR');
  assert.equal(api.uploads.filter(({ name }) => name === plan.assetName).length, 0);
});

test('blocks a deterministic asset-name collision with different content', async () => {
  const report = candidateReport();
  const plan = buildPromotionPlan({ report, sources, sourcesText, repository });
  const api = mockApi({
    release: { id: 1, upload_url: 'https://uploads.test/assets{?name}', html_url: 'https://github.test/release' },
    assets: [{ id: 10, name: plan.assetName, size: candidateBytes.length, digest: `sha256:${'f'.repeat(64)}` }],
  });
  await assert.rejects(scenario(report, api), /asset name collision/);
  assert.equal(api.calls.some(([name]) => name === 'createBranchCommit'), false);
});

test('does not create a duplicate PR for the same full SHA-256', async () => {
  const report = candidateReport();
  const plan = buildPromotionPlan({ report, sources, sourcesText, repository });
  const api = mockApi({ pulls: [{ body: plan.pull.body, html_url: 'https://github.test/pull/existing' }] });
  const { result } = await scenario(report, api);
  assert.equal(result.action, 'REUSED_EXISTING_PR');
  assert.equal(api.calls.some(([name]) => name === 'createPull'), false);
});

test('does not promote untrusted feed-version text into metadata or PR content', () => {
  const report = candidateReport({ feedInfo: { version: '426\nrun: untrusted' } });
  const plan = buildPromotionPlan({ report, sources, sourcesText, repository });
  assert.equal(plan.manifest.feedVersion, null);
  assert.equal(JSON.parse(plan.updatedSourcesText).gtfs.version, undefined);
  assert.doesNotMatch(plan.pull.body, /run: untrusted/);
});

test('propagates GitHub publication and PR errors without modifying local inputs', async () => {
  for (const api of [mockApi({ releaseError: true }), mockApi({ pullError: true })]) {
    const before = readFileSync(new URL('territories/milano-test/sources.json', root), 'utf8');
    await assert.rejects(scenario(candidateReport(), api), /GitHub (release|pull) failure/);
    assert.equal(readFileSync(new URL('territories/milano-test/sources.json', root), 'utf8'), before);
  }
});
