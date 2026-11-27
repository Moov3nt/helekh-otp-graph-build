import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyRetryBound, buildThroughOrchestrator, checkPromotedSources, consecutiveFailures, createChainGitHubApi, decide, dispatchAndWait, graphTag,
  promoteAndMerge, TransientError, verifyGraphBundle,
} from '../scripts/auto02-chain.mjs';
import { buildPromotionPlan } from '../scripts/promote-gtfs-candidate.mjs';

const repository = 'Moov3nt/helekh-otp-graph-build';
const territory = 'milano-test';
const sourcesText = readFileSync(new URL('../territories/milano-test/sources.json', import.meta.url), 'utf8');
const sources = JSON.parse(sourcesText);
const sha = 'a'.repeat(64);
const base = '1'.repeat(40);
const head = '2'.repeat(40);
const parent = '3'.repeat(40);
const now = new Date('2026-12-01T06:00:00Z');

const report = (overrides = {}) => ({
  schema: 'source-candidate-report-v1', territory, source: 'gtfs', checkedAtUtc: '2026-12-01T05:00:00.000Z', state: 'UPDATED_VALID',
  acquisition: { status: 'AVAILABLE', publisherUrl: sources.gtfs.publisherUrl },
  current: { sha256: sources.gtfs.sha256, bytes: sources.gtfs.bytes },
  candidate: { sha256: sha, bytes: 1000, change: 'UPDATED' }, integrity: { zip: 'PASS' }, license: { verdict: 'APPROVED', id: 'CC-BY-4.0' },
  validity: { verdict: 'PASS', trips: 1, servicesWithTrips: 1, effective: { firstServiceDate: '2026-11-30', lastServiceDate: '2027-01-10' } },
  expiry: { daysRemaining: 40 }, feedInfo: { version: '426' }, ...overrides,
});
const retained = (runId = '77', extra = {}) => [{ name: `gtfs-monitor-candidate-${territory}-gtfs-${runId}-${sha}`, expired: false, expires_at: '2026-12-04T05:00:00Z', ...extra }];
const input = (extra = {}) => ({ report: report(), artifacts: retained(), sources, territory, runId: '77', lastSourcesCommit: null, graphDone: false, now, ...extra });

test('a retained valid new feed is promoted', () => {
  const result = decide(input());
  assert.equal(result.action, 'PROMOTE');
  assert.equal(result.sha256, sha);
});

test('a new feed that is already expiring is promoted too', () => {
  assert.equal(decide(input({ report: report({ state: 'EXPIRING' }) })).action, 'PROMOTE');
});

test('an unchanged feed never leads to a build', () => {
  for (const state of ['UNCHANGED', 'EXPIRING', 'EXPIRED', 'UNAVAILABLE']) {
    const unchanged = report({ state, candidate: { sha256: sources.gtfs.sha256, bytes: sources.gtfs.bytes, change: 'UNCHANGED' } });
    // today's main has no published graph either: that alone must not start a build
    assert.equal(decide(input({ report: unchanged, artifacts: [], lastSourcesCommit: { sha: head, parent, message: 'fix(otp): pin verified ATM GTFS input' } })).action, 'SKIP', state);
  }
});

test('invalid, unlicensed, unretained or expired candidates are skipped', () => {
  assert.equal(decide(input({ report: report({ state: 'UPDATED_INVALID' }) })).action, 'SKIP');
  assert.equal(decide(input({ report: report({ license: { verdict: 'UNKNOWN' } }) })).action, 'SKIP');
  assert.equal(decide(input({ artifacts: [] })).action, 'SKIP');
  assert.equal(decide(input({ artifacts: retained('77', { expired: true }) })).action, 'SKIP');
  assert.equal(decide(input({ artifacts: retained('78') })).action, 'SKIP');
  assert.equal(decide(input({ report: null })).action, 'SKIP');
});

test('a merged promotion without a finished graph is resumed, a finished one is not', () => {
  const lastSourcesCommit = { sha: head, parent, message: `chore(gtfs): promote ${territory} ${sha}` };
  const unchanged = report({ state: 'UNCHANGED', candidate: { sha256: sources.gtfs.sha256, bytes: sources.gtfs.bytes, change: 'UNCHANGED' } });
  const resumed = decide(input({ report: unchanged, lastSourcesCommit }));
  assert.equal(resumed.action, 'RESUME');
  assert.equal(resumed.compareWith, parent);
  assert.equal(decide(input({ report: unchanged, lastSourcesCommit, graphDone: true })).action, 'SKIP');
});

const promotedText = buildPromotionPlan({ report: report(), sources, sourcesText, repository }).updatedSourcesText;

test('what the existing promotion writes passes the merge check', () => {
  assert.deepEqual(checkPromotedSources({ before: sources, after: JSON.parse(promotedText), territory, sha256: sha, repository }), []);
});

test('any other change blocks the merge', () => {
  const check = (mutate) => {
    const after = JSON.parse(promotedText);
    mutate(after);
    return checkPromotedSources({ before: sources, after, territory, sha256: sha, repository });
  };
  assert.ok(check((s) => { s.osm.sha256 = 'b'.repeat(64); }).length > 0);
  assert.ok(check((s) => { s.smoke.localTime = '03:00'; }).length > 0);
  assert.ok(check((s) => { s.gtfs.publisherUrl = 'https://example.test/gtfs.zip'; }).length > 0);
  assert.ok(check((s) => { s.gtfs.license = 'other'; }).length > 0);
  assert.ok(check((s) => { s.gtfs.url = 'https://example.test/gtfs.zip'; }).length > 0);
  assert.ok(check((s) => { s.gtfs.validUntil = '2026-11-29'; }).length > 0);
  assert.ok(check((s) => { s.gtfs.mutable = true; }).length > 0);
  assert.ok(check((s) => { s.extra = 1; }).length > 0);
});

const BRANCH_COMMIT = { sha: head, parents: [base], message: `chore(gtfs): promote ${territory} ${sha}`, files: ['territories/milano-test/sources.json'] };

/** A small model of the repository: the branch appears when the promotion runs, main moves on the fast-forward. */
function promotionApi(options = {}) {
  const calls = [];
  const state = { main: base, branch: options.leftover ?? null, runs: 0, merged: false };
  const commits = { [head]: { ...BRANCH_COMMIT, ...(options.commit ?? {}) }, ...(options.commits ?? {}) };
  const plan = options.plan ?? []; // per promotion run: what goes wrong
  const outcome = () => plan[state.runs - 1] ?? {};
  return {
    calls, state,
    async getMainSha() { return options.mainMoves && state.runs > 0 && !state.merged ? (outcome().moves ? '9'.repeat(40) : state.main) : state.main; },
    async getFile(path, ref) { return ref === head ? (options.after ?? promotedText) : sourcesText; },
    async lastCommitFor() { return { sha: head, parent: base, message: BRANCH_COMMIT.message }; },
    async listRuns() { return Array.from({ length: state.runs + 1 }, (_, i) => ({ id: i + 1, event: 'workflow_dispatch', head_sha: state.main })); },
    async dispatch(workflow, inputs) {
      state.runs += 1;
      calls.push(['dispatch', workflow, inputs]);
      if (!outcome().noBranch) state.branch = head;
    },
    async getRun() { return { status: 'completed', conclusion: outcome().conclusion ?? options.conclusion ?? 'success' }; },
    async listJobs() { return [{ name: 'Acquire and validate without mutation', conclusion: outcome().validation ?? 'success' }]; },
    async getBranchSha() { return state.branch; },
    async getCommit(id) { return commits[id]; },
    async getRelease() { return outcome().noRelease ? null : { assets: [{ name: `${territory}-gtfs-${sha}.zip`, size: options.assetSize ?? 1000, digest: `sha256:${sha}` }] }; },
    async fastForwardMain(to) { calls.push(['fastForward', to]); state.main = to; state.merged = true; },
    async deletePromotionBranch(t, s) { calls.push(['delete', t, s]); state.branch = null; },
  };
}
const quick = { pollMilliseconds: 0, sleep: async () => {} };
const pauses = [];
const promote = (api) => promoteAndMerge({ api, repository, territory, monitorRunId: '77', sha256: sha, wait: quick, pause: async (ms) => { pauses.push(ms); } });
const kinds = (api) => api.calls.map((call) => call[0]);

test('promotion reuses the monitor candidate and fast-forwards main', async () => {
  const api = promotionApi();
  const result = await promote(api);
  assert.equal(result.mergedSha, head);
  assert.equal(result.attempts, 1);
  assert.deepEqual(api.calls[0], ['dispatch', 'promote-gtfs.yml', { territory, source: 'gtfs', acquisition_mode: 'monitor_artifact', monitor_run_id: '77' }]);
  assert.deepEqual(api.calls[1], ['fastForward', head]);
});

test('a promotion that only failed to open its pull request is still merged', async () => {
  const api = promotionApi({ conclusion: 'failure' });
  assert.equal((await promote(api)).mergedSha, head);
});

test('temporary failures are retried by themselves and then succeed', async () => {
  for (const first of [{ validation: 'failure', noBranch: true }, { noBranch: true, conclusion: 'failure' }, { noRelease: true }]) {
    const api = promotionApi({ plan: [first] });
    const result = await promote(api);
    assert.equal(result.attempts, 2, JSON.stringify(first));
    assert.equal(kinds(api).filter((k) => k === 'fastForward').length, 1);
  }
});

test('retries are bounded', async () => {
  const fails = { validation: 'failure', noBranch: true }; // a run that fails validation creates nothing
  const api = promotionApi({ plan: [fails, fails, fails, {}] });
  await assert.rejects(promote(api), TransientError);
  assert.equal(api.state.runs, 3);
  assert.equal(api.state.merged, false);
});

test('a branch left on an older main is replaced without a person', async () => {
  const stale = '5'.repeat(40);
  const api = promotionApi({ leftover: stale, commits: { [stale]: { ...BRANCH_COMMIT, sha: stale, parents: [parent] } } });
  assert.equal((await promote(api)).mergedSha, head);
  assert.deepEqual(api.calls[0], ['delete', territory, sha]);
  assert.deepEqual(kinds(api), ['delete', 'dispatch', 'fastForward']);
});

test('a complete branch left on the current main is merged without promoting again', async () => {
  const api = promotionApi({ leftover: head });
  const result = await promote(api);
  assert.equal(result.promotionRunId, null);
  assert.deepEqual(kinds(api), ['fastForward']);
});

test('running again after the merge changes nothing', async () => {
  const api = promotionApi();
  api.getFile = async () => promotedText;
  const result = await promote(api);
  assert.deepEqual(api.calls, []);
  assert.equal(result.baseSha, base);
});

test('a branch that is not a promotion is never deleted or merged', async () => {
  const foreign = '5'.repeat(40);
  for (const change of [{ message: 'work in progress' }, { files: ['territories/milano-test/sources.json', 'x'] }, { parents: [parent, base] }]) {
    const api = promotionApi({ leftover: foreign, commits: { [foreign]: { ...BRANCH_COMMIT, sha: foreign, ...change } } });
    await assert.rejects(promote(api), /left untouched/);
    assert.deepEqual(api.calls, []);
  }
});

test('wrong evidence stops at the first attempt and merges nothing', async () => {
  const cases = {
    files: { commit: { files: ['territories/milano-test/sources.json', '.github/workflows/x.yml'] } },
    message: { commit: { message: 'other' } }, asset: { assetSize: 999 }, content: { after: sourcesText },
  };
  for (const [name, options] of Object.entries(cases)) {
    const api = promotionApi(options);
    await assert.rejects(promote(api), undefined, name);
    assert.equal(api.state.runs, 1, name);
    assert.equal(api.state.merged, false, name);
  }
});

test('automatic runs stop after repeated failures; a manual run is still allowed', () => {
  const runs = [10, 9, 8, 7, 6].map((id) => ({ id, status: 'completed', conclusion: 'failure' }));
  assert.equal(consecutiveFailures([...runs, { id: 11, status: 'in_progress' }, { id: 5, status: 'completed', conclusion: 'success' }], 11), 5);
  assert.equal(consecutiveFailures([{ id: 12, status: 'completed', conclusion: 'success' }, ...runs], 13), 0);
  const promoteDecision = { action: 'PROMOTE', reason: 'x' };
  assert.equal(applyRetryBound(promoteDecision, { failures: 5, event: 'workflow_run' }).action, 'BLOCKED');
  assert.equal(applyRetryBound(promoteDecision, { failures: 4, event: 'workflow_run' }).action, 'PROMOTE');
  assert.equal(applyRetryBound(promoteDecision, { failures: 9, event: 'workflow_dispatch' }).action, 'PROMOTE');
  assert.equal(applyRetryBound({ action: 'SKIP' }, { failures: 9, event: 'workflow_run' }).action, 'SKIP');
});

test('the client can delete only a promotion branch', async () => {
  const calls = [];
  const api = createChainGitHubApi({ repository, token: 't', sleep: async () => {}, fetchImpl: async (url, o) => { calls.push([o.method, url]); return { ok: true, status: 204 }; } });
  await assert.rejects(api.deletePromotionBranch('milano-test', 'main'), /refusing/);
  await assert.rejects(api.deletePromotionBranch('../heads/main', sha), /refusing/);
  await api.deletePromotionBranch(territory, sha);
  assert.deepEqual(calls, [['DELETE', `https://api.github.com/repos/${repository}/git/refs/heads/auto/gtfs-${territory}-${sha}`]]);
});

test('waiting refuses to guess between two new runs and times out without one', async () => {
  let listed = 0;
  const twice = { async listRuns() { listed += 1; return listed === 1 ? [] : [1, 2].map((id) => ({ id, event: 'workflow_dispatch', head_sha: base })); }, async dispatch() {} };
  await assert.rejects(dispatchAndWait({ api: twice, workflow: 'x.yml', inputs: {}, headSha: base, timeoutMilliseconds: 10, ...quick }), /refusing to guess/);
  let time = 0;
  const none = { async listRuns() { return []; }, async dispatch() {} };
  await assert.rejects(dispatchAndWait({ api: none, workflow: 'x.yml', inputs: {}, headSha: base, timeoutMilliseconds: 5, pollMilliseconds: 0, sleep: async () => { time += 3; }, clock: () => time }), /no run appeared/);
});

const fingerprint = 'f'.repeat(64);
function buildApi({ own = true, conclusion = 'success', records = [] } = {}) {
  const calls = [];
  let dispatched = false;
  return {
    calls,
    async getMainSha() { return head; },
    async listRuns() { return dispatched ? [{ id: 900, event: 'workflow_dispatch', head_sha: head }] : []; },
    async dispatch(workflow, inputs) { dispatched = true; calls.push([workflow, inputs]); },
    async getRun() { return { status: 'completed', conclusion }; },
    async listRunArtifacts() { return own ? [{ name: `otp-graph-${territory}-900`, expired: false }] : []; },
    async listArtifactsByName() { return records; },
  };
}
const build = (api) => buildThroughOrchestrator({ api, territory, compareWith: base, fingerprint, wait: quick });

test('the build goes through the existing orchestrator with an explicit authorization', async () => {
  const api = buildApi();
  assert.deepEqual(await build(api), { buildRunId: '900', decision: 'BUILT' });
  assert.deepEqual(api.calls[0], ['orchestrate-graph-build.yml', { territory, compare_with: base, authorize_build: 'true', heap_gb: '12', retention_days: '30' }]);
});

test('an already built graph is reused; a failed or empty evaluation stops the chain', async () => {
  assert.deepEqual(await build(buildApi({ own: false, records: [{ expired: false, workflow_run: { id: 800 } }] })), { buildRunId: '800', decision: 'ALREADY_BUILT' });
  await assert.rejects(build(buildApi({ own: false })), /built nothing/);
  await assert.rejects(build(buildApi({ conclusion: 'failure' })), /did not succeed/);
});

function bundle(mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'auto02-bundle-'));
  const compressed = Buffer.from('compressed-graph');
  writeFileSync(join(directory, 'graph.obj.zst'), compressed);
  const manifest = {
    schema: 'otp-graph-manifest-v2', territory, buildFingerprint: fingerprint, workflow: { runId: '900' },
    inputs: { gtfs: { sha256: sources.gtfs.sha256 }, osm: { sha256: sources.osm.sha256 } }, gtfsValidity: { verdict: 'PASS' },
    routingCheck: { verdict: 'PASS' }, usableUntil: '2027-01-10',
    graph: { sha256: 'c'.repeat(64), bytes: 60_000_000, compressed: { bytes: compressed.length, sha256: createHash('sha256').update(compressed).digest('hex') } },
  };
  const smoke = { verdict: 'PASS', itinerariesWithTransit: 3 };
  mutate({ manifest, smoke, directory });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'routing-check.json'), JSON.stringify(smoke));
  writeFileSync(join(directory, 'gtfs-validity-report.json'), '{}');
  writeFileSync(join(directory, 'NOTICE.md'), 'notice');
  return directory;
}
const verify = (directory) => verifyGraphBundle({ directory, sources, territory, fingerprint, buildRunId: '900', today: '2026-12-01' });

test('a qualified bundle is accepted', async (t) => {
  const directory = bundle();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal((await verify(directory)).tag, graphTag(territory, fingerprint));
});

test('an unqualified bundle is never published', async (t) => {
  const mutations = {
    routing: ({ smoke }) => { smoke.verdict = 'FAIL'; },
    noTransit: ({ smoke }) => { smoke.itinerariesWithTransit = 0; },
    fingerprint: ({ manifest }) => { manifest.buildFingerprint = 'e'.repeat(64); },
    otherRun: ({ manifest }) => { manifest.workflow.runId = '1'; },
    otherFeed: ({ manifest }) => { manifest.inputs.gtfs.sha256 = 'e'.repeat(64); },
    expired: ({ manifest }) => { manifest.usableUntil = '2026-12-01'; },
    tiny: ({ manifest }) => { manifest.graph.bytes = 10; },
    corrupt: ({ directory }) => { truncateSync(join(directory, 'graph.obj.zst'), 3); },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const directory = bundle(mutate);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    await assert.rejects(verify(directory), /rejected/, name);
  }
});

test('a GitHub write is never repeated and main moves only by fast-forward', async () => {
  const calls = [];
  const api = createChainGitHubApi({
    repository, token: 't', sleep: async () => {},
    fetchImpl: async (url, options) => { calls.push([options.method, url, options.body]); return { ok: false, status: 502, text: async () => 'bad gateway' }; },
  });
  await assert.rejects(api.fastForwardMain(head));
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0][2]), { sha: head, force: false });
});
