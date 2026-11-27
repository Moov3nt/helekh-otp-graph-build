#!/usr/bin/env node
// AUTO-02: the links between the existing AUTO-01 stages. It acquires, validates and builds nothing by itself: it reads the
// monitor's report, dispatches the existing promotion and conditional-build workflows, checks what they produced and moves
// one reviewed-shape commit to main. Dependency-free (Node >= 18).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeIdentity } from './graph-build-decision.mjs';
import { candidateRetentionDecision } from './monitor-candidate-artifact.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TERRITORY = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RUN = /^[1-9][0-9]{0,19}$/;
export const HEAP_GB = '12';
const PROMOTABLE_GTFS_KEYS = new Set(['url', 'version', 'bytes', 'sha256', 'validFrom', 'validUntil', 'mutable', 'note']);
const wait = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));

const sourcesPath = (territory) => `territories/${territory}/sources.json`;
export const promotionMessagePrefix = (territory) => `chore(gtfs): promote ${territory} `;
export const graphTag = (territory, fingerprint) => `otp-graph-${territory}-${fingerprint}`;

function requireTerritory(territory) {
  if (!TERRITORY.test(territory ?? '')) throw new Error('territory is invalid');
}

/**
 * What the chain must do after one monitor run. PROMOTE only for a candidate the monitor itself judged valid, updated and
 * retained; RESUME only for a promotion this chain already merged whose graph was never published. An unchanged feed never
 * leads to a build.
 */
export function decide({ report, artifacts, sources, territory, runId, lastSourcesCommit, graphPublished, now = new Date() }) {
  requireTerritory(territory);
  if (!RUN.test(String(runId))) throw new Error('monitor run ID must be a positive integer');
  if (sources?.territory !== territory) throw new Error('sources territory does not match');
  const resume = () => {
    const message = lastSourcesCommit?.message ?? '';
    if (!message.startsWith(promotionMessagePrefix(territory)) || graphPublished) return null;
    if (!COMMIT.test(lastSourcesCommit.sha ?? '') || !COMMIT.test(lastSourcesCommit.parent ?? '')) return null;
    return { action: 'RESUME', reason: 'a promoted feed has no published graph yet', compareWith: lastSourcesCommit.parent };
  };
  const skip = (reason) => resume() ?? { action: 'SKIP', reason };
  if (!report) return skip('the monitor produced no report');
  if (report.territory !== territory || report.source !== 'gtfs') return skip('the report is for another territory or source');
  const retention = candidateRetentionDecision(report);
  if (!retention.retain) return skip(retention.reason);
  const sha256 = report.candidate.sha256;
  if (sources.gtfs.sha256 === sha256) return skip('the candidate is already the approved input');
  const name = `gtfs-monitor-candidate-${territory}-gtfs-${runId}-${sha256}`;
  const artifact = (artifacts ?? []).find((entry) => entry.name === name);
  if (!artifact || artifact.expired || !(new Date(artifact.expires_at) > now)) return skip('the verified candidate was not retained');
  return { action: 'PROMOTE', reason: retention.reason, sha256, validUntil: report.validity.effective.lastServiceDate };
}

/** The promoted sources.json may differ from the approved one only in the snapshot fields of the GTFS feed. */
export function checkPromotedSources({ before, after, territory, sha256, repository }) {
  requireTerritory(territory);
  const problems = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key !== 'gtfs' && JSON.stringify(before[key]) !== JSON.stringify(after[key])) problems.push(`${key} changed`);
  }
  const old = before.gtfs ?? {};
  const next = after.gtfs ?? {};
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (!PROMOTABLE_GTFS_KEYS.has(key) && JSON.stringify(old[key]) !== JSON.stringify(next[key])) problems.push(`gtfs.${key} changed`);
  }
  if (!SHA256.test(sha256 ?? '') || next.sha256 !== sha256) problems.push('gtfs.sha256 is not the validated candidate');
  if (next.sha256 === old.sha256) problems.push('gtfs.sha256 did not change');
  const expected = `https://github.com/${repository}/releases/download/otp-inputs-gtfs-${territory}-${sha256}/${territory}-gtfs-${sha256}.zip`;
  if (next.url !== expected) problems.push('gtfs.url is not the immutable release asset');
  if (next.mutable !== false) problems.push('gtfs.mutable must be false');
  if (!Number.isSafeInteger(next.bytes) || next.bytes <= 0) problems.push('gtfs.bytes is invalid');
  if (!DAY.test(next.validUntil ?? '') || !DAY.test(old.validUntil ?? '') || next.validUntil < old.validUntil) problems.push('gtfs.validUntil regresses or is invalid');
  return problems;
}

/** Dispatches one existing workflow on main and waits for exactly the run that this call created. */
export async function dispatchAndWait({ api, workflow, inputs, headSha, pollMilliseconds = 20000, timeoutMilliseconds, sleep = wait, clock = Date.now }) {
  const known = new Set((await api.listRuns(workflow)).map((run) => run.id));
  await api.dispatch(workflow, inputs);
  const deadline = clock() + timeoutMilliseconds;
  let runId = null;
  for (;;) {
    if (runId === null) {
      const created = (await api.listRuns(workflow)).filter((run) => !known.has(run.id) && run.event === 'workflow_dispatch' && run.head_sha === headSha);
      if (created.length > 1) throw new Error(`more than one new ${workflow} run appeared; refusing to guess`);
      if (created.length === 1) runId = created[0].id;
    }
    if (runId !== null) {
      const run = await api.getRun(runId);
      if (run.status === 'completed') return { runId, conclusion: run.conclusion };
    }
    if (clock() >= deadline) throw new Error(`${workflow} did not complete in time${runId === null ? ' (no run appeared)' : ` (run ${runId})`}`);
    await sleep(pollMilliseconds);
  }
}

/**
 * Runs the existing promotion on the monitor's retained candidate, verifies the branch it produced and fast-forwards main to
 * it. The promotion may fail only in opening its pull request (a repository setting can forbid that to Actions): what counts
 * is that its validation job passed and that the branch and the release it created are exactly right.
 */
export async function promoteAndMerge({ api, repository, territory, monitorRunId, sha256, wait: waitOptions = {} }) {
  requireTerritory(territory);
  const baseSha = await api.getMainSha();
  const before = JSON.parse(await api.getFile(sourcesPath(territory), baseSha));
  const run = await dispatchAndWait({
    api, workflow: 'promote-gtfs.yml', headSha: baseSha, timeoutMilliseconds: 30 * 60 * 1000, ...waitOptions,
    inputs: { territory, source: 'gtfs', acquisition_mode: 'monitor_artifact', monitor_run_id: String(monitorRunId) },
  });
  const jobs = await api.listJobs(run.runId);
  const validation = jobs.find((job) => job.name === 'Acquire and validate without mutation');
  if (validation?.conclusion !== 'success') throw new Error(`promotion validation did not pass (run ${run.runId})`);
  const branch = `auto/gtfs-${territory}-${sha256}`;
  const headSha = await api.getBranchSha(branch);
  if (!headSha) throw new Error(`promotion produced no branch (run ${run.runId}, ${run.conclusion})`);
  const commit = await api.getCommit(headSha);
  if (commit.parents.length !== 1 || commit.parents[0] !== baseSha) throw new Error('promotion branch is not one commit on the evaluated main');
  if (!commit.message.startsWith(promotionMessagePrefix(territory))) throw new Error('promotion commit message is unexpected');
  if (commit.files.length !== 1 || commit.files[0] !== sourcesPath(territory)) throw new Error('promotion commit changes other files');
  const after = JSON.parse(await api.getFile(sourcesPath(territory), headSha));
  const problems = checkPromotedSources({ before, after, territory, sha256, repository });
  if (problems.length > 0) throw new Error(`promoted sources rejected: ${problems.join('; ')}`);
  const release = await api.getRelease(`otp-inputs-gtfs-${territory}-${sha256}`);
  const asset = release?.assets?.find((entry) => entry.name === `${territory}-gtfs-${sha256}.zip`);
  if (!asset || asset.size !== after.gtfs.bytes || (asset.digest && asset.digest !== `sha256:${sha256}`)) throw new Error('promoted release asset is missing or differs');
  if (await api.getMainSha() !== baseSha) throw new Error('main moved during the promotion; nothing was merged');
  await api.fastForwardMain(headSha); // refused by GitHub unless it is a fast-forward
  return { baseSha, mergedSha: headSha, promotionRunId: run.runId };
}

/** Evaluates, builds and qualifies through the existing orchestrator; returns where the qualified graph is. */
export async function buildThroughOrchestrator({ api, territory, compareWith, fingerprint, wait: waitOptions = {} }) {
  requireTerritory(territory);
  if (!COMMIT.test(compareWith ?? '') || !SHA256.test(fingerprint ?? '')) throw new Error('compare revision or fingerprint is invalid');
  const headSha = await api.getMainSha();
  const run = await dispatchAndWait({
    api, workflow: 'orchestrate-graph-build.yml', headSha, timeoutMilliseconds: 170 * 60 * 1000, ...waitOptions,
    inputs: { territory, compare_with: compareWith, authorize_build: 'true', heap_gb: HEAP_GB, retention_days: '30' },
  });
  if (run.conclusion !== 'success') throw new Error(`conditional build did not succeed (run ${run.runId}, ${run.conclusion})`);
  const own = (await api.listRunArtifacts(run.runId)).find((entry) => entry.name === `otp-graph-${territory}-${run.runId}` && !entry.expired);
  if (own) return { buildRunId: String(run.runId), decision: 'BUILT' };
  const records = (await api.listArtifactsByName(`otp-graph-verified-${territory}-${fingerprint}`)).filter((entry) => !entry.expired);
  const origin = records.at(-1)?.workflow_run?.id;
  if (!origin) throw new Error(`run ${run.runId} built nothing and no verified graph exists for this fingerprint`);
  return { buildRunId: String(origin), decision: 'ALREADY_BUILT' };
}

const fileSha256 = (path) => new Promise((accept, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => accept(hash.digest('hex')));
});

/** Nothing is published unless the build's own evidence says this exact graph was built from the approved inputs and routes. */
export async function verifyGraphBundle({ directory, sources, territory, fingerprint, buildRunId, today }) {
  requireTerritory(territory);
  const file = (name) => join(directory, name);
  for (const name of ['manifest.json', 'routing-check.json', 'gtfs-validity-report.json', 'NOTICE.md', 'graph.obj.zst']) {
    if (!existsSync(file(name))) throw new Error(`graph bundle has no ${name}`);
  }
  const manifest = JSON.parse(readFileSync(file('manifest.json'), 'utf8'));
  const smoke = JSON.parse(readFileSync(file('routing-check.json'), 'utf8'));
  const problems = [];
  if (manifest.schema !== 'otp-graph-manifest-v2') problems.push('manifest schema');
  if (manifest.territory !== territory) problems.push('territory');
  if (manifest.buildFingerprint !== fingerprint) problems.push('build fingerprint');
  if (String(manifest.workflow?.runId) !== String(buildRunId)) problems.push('build run');
  if (manifest.inputs?.gtfs?.sha256 !== sources.gtfs.sha256) problems.push('GTFS input');
  if (manifest.inputs?.osm?.sha256 !== sources.osm.sha256) problems.push('OSM input');
  if (manifest.gtfsValidity?.verdict !== 'PASS') problems.push('GTFS validity');
  if (manifest.routingCheck?.verdict !== 'PASS' || smoke.verdict !== 'PASS' || !(smoke.itinerariesWithTransit > 0)) problems.push('routing check');
  if (!DAY.test(manifest.usableUntil ?? '') || !DAY.test(today ?? '') || manifest.usableUntil <= today) problems.push('graph does not cover tomorrow');
  if (!SHA256.test(manifest.graph?.sha256 ?? '') || !(manifest.graph?.bytes > 50_000_000)) problems.push('graph identity');
  const compressed = manifest.graph?.compressed ?? {};
  if (statSync(file('graph.obj.zst')).size !== compressed.bytes || await fileSha256(file('graph.obj.zst')) !== compressed.sha256) problems.push('compressed graph differs from the manifest');
  if (problems.length > 0) throw new Error(`graph bundle rejected: ${problems.join('; ')}`);
  return { tag: graphTag(territory, fingerprint), usableUntil: manifest.usableUntil, graphSha256: manifest.graph.sha256 };
}

export function createChainGitHubApi({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch, sleep = wait }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !token) throw new Error('GitHub repository and token are required');
  const request = async (method, path, { body, allow404 = false, raw = false } = {}) => {
    const attempts = method === 'GET' ? 4 : 1; // a write is never repeated blindly
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
          method,
          headers: { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        if (attempt >= attempts) throw error;
        await sleep(500 * attempt);
        continue;
      }
      if (allow404 && response.status === 404) return null;
      if (response.ok) return raw ? response.text() : response.status === 204 ? null : response.json();
      if (attempt >= attempts || (response.status !== 429 && response.status < 500)) {
        throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      await sleep(500 * attempt);
    }
  };
  return {
    getMainSha: async () => (await request('GET', '/git/ref/heads/main')).object.sha,
    getBranchSha: async (branch) => (await request('GET', `/git/ref/heads/${branch}`, { allow404: true }))?.object.sha ?? null,
    getFile: (path, ref) => request('GET', `/contents/${path}?ref=${encodeURIComponent(ref)}`, { raw: true }),
    async getCommit(sha) {
      const commit = await request('GET', `/commits/${sha}`);
      return { sha: commit.sha, message: commit.commit.message, parents: commit.parents.map((p) => p.sha), files: commit.files.map((f) => f.filename) };
    },
    async lastCommitFor(path) {
      const [commit] = await request('GET', `/commits?sha=main&path=${encodeURIComponent(path)}&per_page=1`);
      return commit ? { sha: commit.sha, message: commit.commit.message, parent: commit.parents[0]?.sha } : null;
    },
    fastForwardMain: (sha) => request('PATCH', '/git/refs/heads/main', { body: { sha, force: false } }),
    dispatch: (workflow, inputs) => request('POST', `/actions/workflows/${workflow}/dispatches`, { body: { ref: 'main', inputs } }),
    listRuns: async (workflow) => (await request('GET', `/actions/workflows/${workflow}/runs?per_page=30`)).workflow_runs,
    getRun: (id) => request('GET', `/actions/runs/${id}`),
    listJobs: async (id) => (await request('GET', `/actions/runs/${id}/jobs?per_page=100`)).jobs,
    listRunArtifacts: async (id) => (await request('GET', `/actions/runs/${id}/artifacts?per_page=100`)).artifacts,
    listArtifactsByName: async (name) => (await request('GET', `/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`)).artifacts
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
    getRelease: (tag) => request('GET', `/releases/tags/${encodeURIComponent(tag)}`, { allow404: true }),
  };
}

const todayIn = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function main(argv) {
  const [operation, ...rest] = argv;
  const args = new Map();
  for (let index = 0; index < rest.length; index += 2) args.set(rest[index], rest[index + 1]);
  const need = (name) => args.get(name) ?? (() => { throw new Error(`${name} is required`); })();
  const territory = need('--territory');
  requireTerritory(territory);
  const repository = process.env.GITHUB_REPOSITORY;
  const readSources = () => JSON.parse(readFileSync(resolve(sourcesPath(territory)), 'utf8'));
  const fingerprint = () => computeIdentity({ territory, heapGb: HEAP_GB }).fingerprint;
  const api = () => createChainGitHubApi({ repository, token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL });
  let result;
  if (operation === 'decide') {
    const reportPath = resolve(need('--report'));
    const client = api();
    const runId = need('--run-id');
    const release = await client.getRelease(graphTag(territory, fingerprint()));
    result = decide({
      report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null,
      artifacts: await client.listRunArtifacts(runId), sources: readSources(), territory, runId,
      lastSourcesCommit: await client.lastCommitFor(sourcesPath(territory)), graphPublished: release !== null,
    });
  } else if (operation === 'promote') {
    result = await promoteAndMerge({ api: api(), repository, territory, monitorRunId: need('--run-id'), sha256: need('--sha256') });
  } else if (operation === 'build') {
    const value = fingerprint(); // of the checked-out main, after any merge
    result = { ...await buildThroughOrchestrator({ api: api(), territory, compareWith: need('--compare-with'), fingerprint: value }), fingerprint: value };
  } else if (operation === 'verify-graph') {
    const sources = readSources();
    const value = need('--fingerprint');
    if (value !== fingerprint()) throw new Error('main no longer matches the built fingerprint');
    result = await verifyGraphBundle({ directory: resolve(need('--directory')), sources, territory, fingerprint: value, buildRunId: need('--build-run-id'), today: todayIn(sources.timezone) });
  } else throw new Error(`unknown operation: ${operation}`);
  const out = args.get('--out');
  if (out) writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(`auto02-chain: ${error.message}`); process.exitCode = 1; });
}
