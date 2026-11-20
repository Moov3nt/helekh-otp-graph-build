import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildNotice, createGitHubApi, synchronizeIssue, synchronizeReportFile } from '../scripts/sync-monitor-issue.mjs';

function report(overrides = {}) {
  const base = {
    schema: 'source-candidate-report-v1', territory: 'milano-test', source: 'gtfs', state: 'EXPIRING',
    acquisition: { status: 'AVAILABLE' }, current: { sha256: 'a'.repeat(64) },
    candidate: { sha256: 'a'.repeat(64), bytes: 100, change: 'UNCHANGED' },
    integrity: { zip: 'PASS' }, license: { verdict: 'APPROVED' }, validity: { verdict: 'PASS' },
    expiry: { lastServiceDate: '2026-11-30', daysRemaining: 10, warningLevelDays: 14 }, problems: [],
  };
  return { ...base, ...overrides, candidate: { ...base.candidate, ...(overrides.candidate ?? {}) }, expiry: { ...base.expiry, ...(overrides.expiry ?? {}) } };
}

function fakeApi(initial = []) {
  const issues = initial.map((issue) => ({ ...issue }));
  const calls = [];
  return {
    issues, calls,
    async listIssues() { calls.push(['list']); return issues.map((issue) => ({ ...issue })); },
    async createIssue(payload) { calls.push(['create', payload]); const issue = { number: 50, state: 'open', ...payload }; issues.push(issue); return issue; },
    async updateIssue(number, payload) { calls.push(['update', number, payload]); Object.assign(issues.find((issue) => issue.number === number), payload); return issues.find((issue) => issue.number === number); },
  };
}

test('creates the first persistent issue', async () => {
  const api = fakeApi();
  const result = await synchronizeIssue(report(), api);
  assert.equal(result.action, 'CREATED');
  assert.equal(api.calls.filter(([kind]) => kind === 'create').length, 1);
});

test('updates an existing issue when significant state changes', async () => {
  const old = buildNotice(report());
  const api = fakeApi([{ number: 7, state: 'open', body: old.body, title: old.title }]);
  const result = await synchronizeIssue(report({ state: 'UNAVAILABLE', acquisition: { status: 'UNAVAILABLE' }, candidate: { sha256: null, bytes: null, change: 'UNKNOWN' } }), api);
  assert.equal(result.action, 'UPDATED');
  assert.equal(api.calls.filter(([kind]) => kind === 'update').length, 1);
});

test('does not update when significant content is unchanged', async () => {
  const original = report();
  const notice = buildNotice(original);
  const api = fakeApi([{ number: 7, state: 'open', body: notice.body, title: 'operator may edit this title' }]);
  const result = await synchronizeIssue(report({ expiry: { daysRemaining: 9 } }), api);
  assert.equal(result.action, 'UNCHANGED');
  assert.deepEqual(api.calls, [['list']]);
});

test('updates only when an expiry threshold changes', async () => {
  const old = buildNotice(report({ expiry: { daysRemaining: 15, warningLevelDays: 21 } }));
  const api = fakeApi([{ number: 7, state: 'open', body: old.body }]);
  const result = await synchronizeIssue(report({ expiry: { daysRemaining: 14, warningLevelDays: 14 } }), api);
  assert.equal(result.action, 'UPDATED');
});

test('distinguishes a new valid feed while EXPIRING', async () => {
  const notice = buildNotice(report({ candidate: { sha256: 'b'.repeat(64), change: 'UPDATED' } }));
  assert.equal(notice.snapshot.kind, 'UPDATED_EXPIRING');
  assert.match(notice.body, /Candidate change \| `UPDATED`/);
});

test('distinguishes a new valid feed with sufficient coverage', async () => {
  const notice = buildNotice(report({
    state: 'UPDATED_VALID', candidate: { sha256: 'b'.repeat(64), change: 'UPDATED' },
    expiry: { lastServiceDate: '2027-01-31', daysRemaining: 72, warningLevelDays: null },
  }));
  assert.equal(notice.snapshot.kind, 'UPDATED_VALID');
  assert.equal(notice.attention, true);
});

test('keeps an issue open when UNAVAILABLE recovers to another attention state', async () => {
  const old = buildNotice(report({ state: 'UNAVAILABLE', acquisition: { status: 'UNAVAILABLE' }, candidate: { sha256: null, change: 'UNKNOWN' } }));
  const api = fakeApi([{ number: 7, state: 'open', body: old.body }]);
  const result = await synchronizeIssue(report(), api);
  assert.equal(result.action, 'UPDATED');
  assert.equal(api.issues[0].state, 'open');
});

test('closes the issue after genuine resolution', async () => {
  const old = buildNotice(report());
  const api = fakeApi([{ number: 7, state: 'open', body: old.body }]);
  const result = await synchronizeIssue(report({ state: 'UNCHANGED', expiry: { warningLevelDays: null, daysRemaining: 40 } }), api);
  assert.equal(result.action, 'CLOSED');
  assert.equal(api.issues[0].state, 'closed');
});

test('keeps one canonical issue and closes pre-existing duplicates', async () => {
  const notice = buildNotice(report());
  const api = fakeApi([
    { number: 9, state: 'open', body: notice.body },
    { number: 4, state: 'open', body: notice.body },
    { number: 2, state: 'closed', body: notice.body },
  ]);
  const result = await synchronizeIssue(report(), api);
  assert.equal(result.issueNumber, 4);
  assert.equal(result.duplicatesClosed, 1);
  assert.equal(api.issues.find(({ number }) => number === 9).state, 'closed');
});

test('preserves the report when the GitHub API fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helekh-issue-test-'));
  try {
    const path = join(directory, 'report.json');
    const original = `${JSON.stringify(report(), null, 2)}\n`;
    writeFileSync(path, original);
    const api = { async listIssues() { throw new Error('HTTP 403'); } };
    await assert.rejects(synchronizeReportFile(path, api), /HTTP 403/);
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retries transient GitHub API errors but not permission failures', async () => {
  let transientCalls = 0;
  const transientApi = createGitHubApi({
    repository: 'Moov3nt/helekh-otp-graph-build', token: 'test-token', sleep: async () => {},
    fetchImpl: async () => {
      transientCalls += 1;
      if (transientCalls < 3) return { ok: false, status: 503, text: async () => 'temporary failure' };
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  assert.deepEqual(await transientApi.listIssues(), []);
  assert.equal(transientCalls, 3);

  let permissionCalls = 0;
  const permissionApi = createGitHubApi({
    repository: 'Moov3nt/helekh-otp-graph-build', token: 'test-token', sleep: async () => {},
    fetchImpl: async () => {
      permissionCalls += 1;
      return { ok: false, status: 403, text: async () => 'resource not accessible' };
    },
  });
  await assert.rejects(permissionApi.listIssues(), /HTTP 403/);
  assert.equal(permissionCalls, 1);
});
