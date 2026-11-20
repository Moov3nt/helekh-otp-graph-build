// Package, resolve and verify temporary GTFS candidates exchanged between the monitor and manual promotion workflows.
// Archives are treated as opaque data; this script never executes their contents.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{64}$/;
const identityPattern = /^[a-z0-9][a-z0-9-]{0,40}$/;
const runPattern = /^[1-9][0-9]{0,19}$/;
const authorizedWorkflow = '.github/workflows/monitor-sources.yml';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const fileInfo = (path) => {
  const buffer = readFileSync(path);
  return { buffer, bytes: buffer.length, sha256: sha256(buffer) };
};

function requireIdentity(territory, source) {
  if (!identityPattern.test(territory ?? '') || source !== 'gtfs') throw new Error('invalid territory or source identity');
}

export function candidateRetentionDecision(report) {
  if (report?.schema !== 'source-candidate-report-v1') return { retain: false, reason: 'INVALID_REPORT' };
  if (report.candidate?.change !== 'UPDATED') return { retain: false, reason: 'UNCHANGED' };
  if (!['UPDATED_VALID', 'EXPIRING'].includes(report.state)) return { retain: false, reason: `STATE_${report.state}` };
  if (report.integrity?.zip !== 'PASS') return { retain: false, reason: 'ZIP_INVALID' };
  if (report.license?.verdict !== 'APPROVED') return { retain: false, reason: 'LICENSE_NOT_APPROVED' };
  if (report.validity?.verdict !== 'PASS') return { retain: false, reason: 'GTFS_INVALID' };
  if (!Number.isInteger(report.expiry?.daysRemaining) || report.expiry.daysRemaining < 0) return { retain: false, reason: 'GTFS_EXPIRED' };
  if (!shaPattern.test(report.candidate?.sha256 ?? '') || !Number.isInteger(report.candidate?.bytes) || report.candidate.bytes <= 0) return { retain: false, reason: 'INVALID_CANDIDATE_IDENTITY' };
  return { retain: true, reason: 'VALID_UPDATED_CANDIDATE' };
}

export function packageMonitorCandidate({ reportPath, candidatePath, outputDirectory, repository, workflowPath = authorizedWorkflow, runId, runAttempt, headSha, territory, source, createdAtUtc }) {
  requireIdentity(territory, source);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || workflowPath !== authorizedWorkflow || !runPattern.test(String(runId)) || !/^[0-9a-f]{40}$/.test(headSha ?? '')) throw new Error('invalid monitor origin metadata');
  const reportBuffer = readFileSync(reportPath);
  const report = JSON.parse(reportBuffer.toString('utf8'));
  const decision = candidateRetentionDecision(report);
  if (!decision.retain) return { available: false, reason: decision.reason, artifactName: null };
  if (!existsSync(candidatePath)) throw new Error('validated candidate file is missing');
  const candidate = fileInfo(candidatePath);
  if (candidate.sha256 !== report.candidate.sha256 || candidate.bytes !== report.candidate.bytes) throw new Error('candidate differs from monitor report');
  if (report.territory !== territory || report.source !== source) throw new Error('monitor report identity differs from requested source');
  const artifactName = `gtfs-monitor-candidate-${territory}-${source}-${runId}-${candidate.sha256}`;
  const origin = {
    schema: 'monitor-candidate-origin-v1', repository, workflowPath, runId: String(runId), runAttempt: String(runAttempt), headSha,
    territory, source, createdAtUtc, artifactName,
    candidate: { file: 'candidate.zip', sha256: candidate.sha256, bytes: candidate.bytes },
    report: { file: 'report.json', sha256: sha256(reportBuffer), bytes: reportBuffer.length },
  };
  mkdirSync(outputDirectory, { recursive: true });
  copyFileSync(candidatePath, resolve(outputDirectory, 'candidate.zip'));
  writeFileSync(resolve(outputDirectory, 'report.json'), reportBuffer);
  writeFileSync(resolve(outputDirectory, 'origin.json'), `${JSON.stringify(origin, null, 2)}\n`);
  return { available: true, reason: decision.reason, artifactName, sha256: candidate.sha256, bytes: candidate.bytes };
}

export async function resolveMonitorCandidate({ api, repository, runId, territory, source, now = new Date() }) {
  requireIdentity(territory, source);
  if (!runPattern.test(String(runId))) throw new Error('monitor run ID must be a positive integer');
  const [run, workflow, artifacts] = await Promise.all([api.getRun(runId), api.getWorkflow('monitor-sources.yml'), api.listArtifacts(runId)]);
  if (run?.id !== Number(runId) || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) throw new Error('monitor artifact repository or run ID is discordant');
  if (run.path !== authorizedWorkflow || run.workflow_id !== workflow?.id) throw new Error('monitor run was produced by an unauthorized workflow');
  if (run.head_branch !== 'main' || !['schedule', 'workflow_dispatch'].includes(run.event)) throw new Error('monitor run was not executed from the authorized main branch and event');
  if (run.status !== 'completed' || !['success', 'failure'].includes(run.conclusion)) throw new Error('monitor run is not complete');
  const prefix = `gtfs-monitor-candidate-${territory}-${source}-${runId}-`;
  const matching = artifacts.filter((artifact) => artifact.name?.startsWith(prefix));
  if (matching.length === 0) throw new Error('verified monitor candidate artifact is missing or was never retained');
  if (matching.length !== 1) throw new Error('multiple candidate artifacts match the requested monitor run');
  const artifact = matching[0];
  const candidateSha256 = artifact.name.slice(prefix.length);
  if (!shaPattern.test(candidateSha256)) throw new Error('candidate artifact name has an invalid SHA-256');
  const expiresAt = new Date(artifact.expires_at ?? '');
  if (artifact.expired || Number.isNaN(expiresAt.valueOf()) || expiresAt <= now) throw new Error('verified monitor candidate artifact has expired');
  if (artifact.workflow_run?.id !== undefined && artifact.workflow_run.id !== Number(runId)) throw new Error('candidate artifact run ID is discordant');
  if (!/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '')) throw new Error('candidate artifact has no valid GitHub digest');
  return {
    schema: 'monitor-candidate-resolution-v1', repository, workflowId: workflow.id, workflowPath: authorizedWorkflow,
    runId: String(runId), runAttempt: String(run.run_attempt), headSha: run.head_sha, territory, source, artifactId: artifact.id, artifactName: artifact.name,
    artifactDigest: artifact.digest, artifactBytes: artifact.size_in_bytes, expiresAt: artifact.expires_at, candidateSha256,
  };
}

export function verifyDownloadedMonitorCandidate({ resolutionPath, originPath, reportPath, candidatePath, repository, runId, territory, source }) {
  requireIdentity(territory, source);
  const resolution = JSON.parse(readFileSync(resolutionPath, 'utf8'));
  const originBuffer = readFileSync(originPath);
  const origin = JSON.parse(originBuffer.toString('utf8'));
  const reportData = fileInfo(reportPath);
  const report = JSON.parse(reportData.buffer.toString('utf8'));
  const candidate = fileInfo(candidatePath);
  if (resolution.schema !== 'monitor-candidate-resolution-v1' || resolution.repository !== repository || resolution.runId !== String(runId) || resolution.territory !== territory || resolution.source !== source || resolution.workflowPath !== authorizedWorkflow) throw new Error('resolved artifact provenance is discordant');
  if (origin.schema !== 'monitor-candidate-origin-v1' || origin.repository !== repository || origin.workflowPath !== authorizedWorkflow || origin.runId !== String(runId) || origin.runAttempt !== resolution.runAttempt || origin.headSha !== resolution.headSha || origin.territory !== territory || origin.source !== source) throw new Error('downloaded artifact origin is discordant');
  if (origin.artifactName !== resolution.artifactName || origin.candidate?.sha256 !== resolution.candidateSha256) throw new Error('downloaded artifact identity is discordant');
  if (origin.report?.sha256 !== reportData.sha256 || origin.report?.bytes !== reportData.bytes) throw new Error('monitor report digest or size is discordant');
  if (origin.candidate?.sha256 !== candidate.sha256 || origin.candidate?.bytes !== candidate.bytes) throw new Error('candidate ZIP digest or size is discordant');
  if (report.territory !== territory || report.source !== source || report.candidate?.sha256 !== candidate.sha256 || report.candidate?.bytes !== candidate.bytes) throw new Error('monitor report candidate identity is discordant');
  const decision = candidateRetentionDecision(report);
  if (!decision.retain) throw new Error(`downloaded monitor candidate is not eligible: ${decision.reason}`);
  return { verified: true, sha256: candidate.sha256, bytes: candidate.bytes, artifactName: resolution.artifactName };
}

const wait = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));
export function createActionsApi({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch, sleep = wait, maximumAttempts = 3 } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !token) throw new Error('GitHub repository and token are required');
  const get = async (path) => {
    let lastError;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000) });
        if (response.ok) return response.json();
        const message = (await response.text()).slice(0, 300);
        const error = new Error(`GitHub API GET ${path} failed with HTTP ${response.status}: ${message}`);
        error.status = response.status;
        if (attempt === maximumAttempts || (response.status !== 429 && response.status < 500)) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (attempt === maximumAttempts || error.status && error.status < 500 && error.status !== 429) throw error;
      }
      await sleep(250 * (2 ** (attempt - 1)));
    }
    throw lastError;
  };
  return {
    getRun: (runId) => get(`/actions/runs/${runId}`),
    getWorkflow: (workflowPath) => get(`/actions/workflows/${encodeURIComponent(workflowPath)}`),
    async listArtifacts(runId) {
      const output = [];
      for (let page = 1; page <= 10; page += 1) {
        const response = await get(`/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
        output.push(...response.artifacts);
        if (response.artifacts.length < 100) return output;
      }
      throw new Error('artifact scan exceeded 1000 entries');
    },
  };
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const need = (name) => args.get(name) ?? (() => { throw new Error(`${name} is required`); })();
  const operation = need('--operation');
  let result;
  if (operation === 'package') {
    result = packageMonitorCandidate({
      reportPath: resolve(need('--report')), candidatePath: resolve(need('--candidate')), outputDirectory: resolve(need('--directory')),
      repository: need('--repository'), workflowPath: need('--workflow'), runId: need('--run-id'), runAttempt: need('--run-attempt'), headSha: need('--head-sha'),
      territory: need('--territory'), source: need('--source'), createdAtUtc: need('--created-at'),
    });
  } else if (operation === 'resolve') {
    const repository = process.env.GITHUB_REPOSITORY;
    result = await resolveMonitorCandidate({ api: createActionsApi({ repository, token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL }), repository, runId: need('--run-id'), territory: need('--territory'), source: need('--source') });
  } else if (operation === 'verify') {
    result = verifyDownloadedMonitorCandidate({
      resolutionPath: resolve(need('--resolution')), originPath: resolve(need('--origin')), reportPath: resolve(need('--report')), candidatePath: resolve(need('--candidate')),
      repository: need('--repository'), runId: need('--run-id'), territory: need('--territory'), source: need('--source'),
    });
  } else throw new Error(`unknown operation: ${operation}`);
  const out = args.get('--out');
  if (out) writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`monitor-candidate-artifact: ${error.message}`); process.exitCode = 1; });
}
