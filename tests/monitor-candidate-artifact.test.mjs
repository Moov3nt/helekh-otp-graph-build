import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { candidateRetentionDecision, packageMonitorCandidate, resolveMonitorCandidate, verifyDownloadedMonitorCandidate } from '../scripts/monitor-candidate-artifact.mjs';

const repository = 'Moov3nt/helekh-otp-graph-build';
const territory = 'milano-test';
const source = 'gtfs';
const runId = '45000000001';
const headSha = 'a'.repeat(40);
const candidateBuffer = Buffer.from('verified-monitor-gtfs-candidate');
const candidateSha = createHash('sha256').update(candidateBuffer).digest('hex');
const report = (overrides = {}) => {
  const base = {
    schema: 'source-candidate-report-v1', territory, source, state: 'UPDATED_VALID',
    candidate: { change: 'UPDATED', sha256: candidateSha, bytes: candidateBuffer.length },
    integrity: { zip: 'PASS' }, license: { verdict: 'APPROVED' }, validity: { verdict: 'PASS' },
    expiry: { daysRemaining: 40 },
  };
  return {
    ...base, ...overrides,
    candidate: { ...base.candidate, ...(overrides.candidate ?? {}) }, integrity: { ...base.integrity, ...(overrides.integrity ?? {}) },
    license: { ...base.license, ...(overrides.license ?? {}) }, validity: { ...base.validity, ...(overrides.validity ?? {}) },
    expiry: { ...base.expiry, ...(overrides.expiry ?? {}) },
  };
};

function workspace(candidateReport = report()) {
  const directory = mkdtempSync(join(tmpdir(), 'helekh-monitor-candidate-'));
  const candidatePath = join(directory, 'candidate.zip');
  const reportPath = join(directory, 'report.json');
  const outputDirectory = join(directory, 'artifact');
  writeFileSync(candidatePath, candidateBuffer);
  writeFileSync(reportPath, `${JSON.stringify(candidateReport, null, 2)}\n`);
  return { directory, candidatePath, reportPath, outputDirectory };
}

function packageOne(candidateReport = report()) {
  const paths = workspace(candidateReport);
  const result = packageMonitorCandidate({
    reportPath: paths.reportPath, candidatePath: paths.candidatePath, outputDirectory: paths.outputDirectory,
    repository, workflowPath: '.github/workflows/monitor-sources.yml', runId, runAttempt: '1', headSha,
    territory, source, createdAtUtc: '2026-11-20T10:00:00Z',
  });
  return { ...paths, result };
}

function mockActionsApi({ path = '.github/workflows/monitor-sources.yml', artifacts, conclusion = 'success' } = {}) {
  return {
    async getRun(id) {
      return { id: Number(id), path, workflow_id: 77, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion, run_attempt: 1, head_sha: headSha, repository: { full_name: repository }, head_repository: { full_name: repository } };
    },
    async getWorkflow() { return { id: 77 }; },
    async listArtifacts() { return artifacts ?? []; },
  };
}

function artifactFor(name, overrides = {}) {
  return {
    id: 10, name, expired: false, expires_at: '2026-11-23T10:00:00Z', digest: `sha256:${'b'.repeat(64)}`,
    size_in_bytes: 100, workflow_run: { id: Number(runId) }, ...overrides,
  };
}

test('packages a new valid monitor candidate with report and origin', () => {
  const item = packageOne();
  try {
    assert.equal(item.result.available, true);
    assert.match(item.result.artifactName, new RegExp(`${runId}-${candidateSha}$`));
    for (const file of ['candidate.zip', 'report.json', 'origin.json']) assert.equal(existsSync(join(item.outputDirectory, file)), true);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('does not duplicate an unchanged feed', () => {
  const item = packageOne(report({ state: 'UNCHANGED', candidate: { change: 'UNCHANGED' } }));
  try {
    assert.deepEqual(item.result, { available: false, reason: 'UNCHANGED', artifactName: null });
    assert.equal(existsSync(item.outputDirectory), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

for (const [name, value, reason] of [
  ['invalid ZIP', report({ state: 'UPDATED_INVALID', integrity: { zip: 'FAIL' } }), 'STATE_UPDATED_INVALID'],
  ['unapproved licence', report({ state: 'LICENSE_UNKNOWN', license: { verdict: 'UNKNOWN' } }), 'STATE_LICENSE_UNKNOWN'],
  ['expired calendar', report({ state: 'EXPIRED', expiry: { daysRemaining: -1 } }), 'STATE_EXPIRED'],
]) test(`does not retain a candidate with ${name}`, () => {
  assert.equal(candidateRetentionDecision(value).retain, false);
  assert.equal(candidateRetentionDecision(value).reason, reason);
});

test('rejects a missing or expired monitor artifact', async () => {
  await assert.rejects(resolveMonitorCandidate({ api: mockActionsApi(), repository, runId, territory, source }), /missing/);
  const name = `gtfs-monitor-candidate-${territory}-${source}-${runId}-${candidateSha}`;
  await assert.rejects(resolveMonitorCandidate({ api: mockActionsApi({ artifacts: [artifactFor(name, { expired: true })] }), repository, runId, territory, source }), /expired/);
});

test('rejects an artifact from an unauthorized workflow', async () => {
  const name = `gtfs-monitor-candidate-${territory}-${source}-${runId}-${candidateSha}`;
  await assert.rejects(resolveMonitorCandidate({ api: mockActionsApi({ path: '.github/workflows/other.yml', artifacts: [artifactFor(name)] }), repository, runId, territory, source }), /unauthorized workflow/);
});

test('rejects a monitor run outside the authorized main branch', async () => {
  const name = `gtfs-monitor-candidate-${territory}-${source}-${runId}-${candidateSha}`;
  const api = mockActionsApi({ artifacts: [artifactFor(name)] });
  const original = api.getRun;
  api.getRun = async (id) => ({ ...(await original(id)), head_branch: 'feature/untrusted' });
  await assert.rejects(resolveMonitorCandidate({ api, repository, runId, territory, source }), /authorized main branch/);
});

async function resolvedPackage() {
  const item = packageOne();
  const artifact = artifactFor(item.result.artifactName);
  const resolution = await resolveMonitorCandidate({ api: mockActionsApi({ artifacts: [artifact] }), repository, runId, territory, source, now: new Date('2026-11-20T12:00:00Z') });
  const resolutionPath = join(item.directory, 'resolution.json');
  writeFileSync(resolutionPath, `${JSON.stringify(resolution, null, 2)}\n`);
  return { ...item, resolution, resolutionPath };
}

test('rejects territory or source discordance in downloaded contents', async () => {
  const item = await resolvedPackage();
  try {
    assert.throws(() => verifyDownloadedMonitorCandidate({
      resolutionPath: item.resolutionPath, originPath: join(item.outputDirectory, 'origin.json'), reportPath: join(item.outputDirectory, 'report.json'), candidatePath: join(item.outputDirectory, 'candidate.zip'),
      repository, runId, territory: 'other-territory', source,
    }), /discordant/);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('rejects a discordant recorded SHA-256', async () => {
  const item = await resolvedPackage();
  try {
    const originPath = join(item.outputDirectory, 'origin.json');
    const origin = JSON.parse(readFileSync(originPath, 'utf8'));
    origin.candidate.sha256 = 'f'.repeat(64);
    writeFileSync(originPath, JSON.stringify(origin));
    assert.throws(() => verifyDownloadedMonitorCandidate({
      resolutionPath: item.resolutionPath, originPath, reportPath: join(item.outputDirectory, 'report.json'), candidatePath: join(item.outputDirectory, 'candidate.zip'), repository, runId, territory, source,
    }), /identity is discordant/);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('rejects an altered candidate ZIP', async () => {
  const item = await resolvedPackage();
  try {
    writeFileSync(join(item.outputDirectory, 'candidate.zip'), Buffer.from('altered'));
    assert.throws(() => verifyDownloadedMonitorCandidate({
      resolutionPath: item.resolutionPath, originPath: join(item.outputDirectory, 'origin.json'), reportPath: join(item.outputDirectory, 'report.json'), candidatePath: join(item.outputDirectory, 'candidate.zip'), repository, runId, territory, source,
    }), /digest or size is discordant/);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('accepts the exact valid candidate for fresh promotion validation', async () => {
  const item = await resolvedPackage();
  try {
    const result = verifyDownloadedMonitorCandidate({
      resolutionPath: item.resolutionPath, originPath: join(item.outputDirectory, 'origin.json'), reportPath: join(item.outputDirectory, 'report.json'), candidatePath: join(item.outputDirectory, 'candidate.zip'), repository, runId, territory, source,
    });
    assert.deepEqual(result, { verified: true, sha256: candidateSha, bytes: candidateBuffer.length, artifactName: item.result.artifactName });
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('workflow preserves explicit direct mode and has no artifact fallback', () => {
  const workflow = readFileSync(new URL('../.github/workflows/promote-gtfs.yml', import.meta.url), 'utf8');
  assert.match(workflow, /default: direct/);
  assert.match(workflow, /if: inputs\.acquisition_mode == 'direct'/);
  assert.match(workflow, /if: inputs\.acquisition_mode == 'monitor_artifact'/);
  const artifactSection = workflow.slice(workflow.indexOf('Resolve the exact authorized monitor artifact'), workflow.indexOf('Validate the selected candidate again'));
  assert.doesNotMatch(artifactSection, /curl|publisherUrl/);
  assert.match(workflow, /no fallback to another artifact or to the publisher was attempted/);
});

test('monitor advertises a candidate only after a successful three-day upload', () => {
  const workflow = readFileSync(new URL('../.github/workflows/monitor-sources.yml', import.meta.url), 'utf8');
  assert.match(workflow, /Retain the new verified candidate for manual promotion/);
  assert.match(workflow, /retention-days: 3/);
  assert.match(workflow, /steps\.preserve\.outcome.*success/);
  assert.match(workflow, /NOT AVAILABLE.*temporary artifact upload failed/);
});
