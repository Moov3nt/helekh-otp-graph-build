// Synchronize one persistent GitHub issue from an observe-only source report.
// Feed data is treated only as JSON data and is never evaluated or passed to a shell.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identityPattern = /^[a-z0-9][a-z0-9-]{0,40}$/;
const validStates = new Set(['UNAVAILABLE', 'UNCHANGED', 'UPDATED_VALID', 'UPDATED_INVALID', 'LICENSE_UNKNOWN', 'EXPIRING', 'EXPIRED']);
const markerFor = (territory, source) => `<!-- helekh-source-monitor:v1 territory=${territory} source=${source} -->`;
const fingerprintMarker = (fingerprint) => `<!-- helekh-source-monitor-fingerprint:${fingerprint} -->`;

function requireReport(report) {
  if (report?.schema !== 'source-candidate-report-v1') throw new Error('unsupported monitor report schema');
  if (!identityPattern.test(report.territory ?? '') || !identityPattern.test(report.source ?? '')) throw new Error('invalid report identity');
  if (!validStates.has(report.state)) throw new Error(`unknown monitor state: ${report.state}`);
}

function noticeKind(report) {
  if (report.state === 'EXPIRING') return report.candidate?.change === 'UPDATED' ? 'UPDATED_EXPIRING' : 'UNCHANGED_EXPIRING';
  return report.state;
}

function needsAttention(report) {
  return report.state !== 'UNCHANGED' || report.candidate?.change === 'UPDATED';
}

function significantSnapshot(report) {
  return {
    schema: 'source-monitor-notice-v1',
    territory: report.territory,
    source: report.source,
    kind: noticeKind(report),
    state: report.state,
    acquisition: report.acquisition?.status ?? null,
    currentSha256: report.current?.sha256 ?? null,
    candidateSha256: report.candidate?.sha256 ?? null,
    candidateBytes: report.candidate?.bytes ?? null,
    candidateChange: report.candidate?.change ?? 'UNKNOWN',
    zipIntegrity: report.integrity?.zip ?? null,
    licenseVerdict: report.license?.verdict ?? null,
    validityVerdict: report.validity?.verdict ?? null,
    lastServiceDate: report.expiry?.lastServiceDate ?? null,
    warningLevelDays: report.expiry?.warningLevelDays ?? null,
    problems: [...(report.problems ?? [])].map(String).sort(),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const display = (value) => value === null || value === undefined ? 'unknown' : String(value).replace(/[\r\n|`]/g, ' ');

export function buildNotice(report) {
  requireReport(report);
  const snapshot = significantSnapshot(report);
  const fingerprint = sha256(JSON.stringify(snapshot));
  const titles = {
    UNAVAILABLE: 'source unavailable',
    UPDATED_VALID: 'new valid feed available',
    UPDATED_INVALID: 'feed candidate is invalid',
    LICENSE_UNKNOWN: 'feed licence requires review',
    EXPIRED: 'feed has expired',
    UNCHANGED_EXPIRING: 'unchanged feed is expiring',
    UPDATED_EXPIRING: 'new valid feed is expiring',
    UNCHANGED: 'source healthy',
  };
  const title = `[source monitor] ${report.territory}/${report.source}: ${titles[snapshot.kind]}`;
  const body = [
    markerFor(report.territory, report.source),
    fingerprintMarker(fingerprint),
    '',
    'This issue is maintained by the HELEKH observe-only source monitor. No input, graph or production service is changed.',
    '',
    '| Signal | Value |',
    '| --- | --- |',
    `| Classification | \`${display(snapshot.kind)}\` |`,
    `| Monitor state | \`${display(snapshot.state)}\` |`,
    `| Candidate change | \`${display(snapshot.candidateChange)}\` |`,
    `| Candidate SHA-256 | \`${display(snapshot.candidateSha256)}\` |`,
    `| ZIP integrity | \`${display(snapshot.zipIntegrity)}\` |`,
    `| Licence | \`${display(snapshot.licenseVerdict)}\` |`,
    `| GTFS validity | \`${display(snapshot.validityVerdict)}\` |`,
    `| Effective last service date | \`${display(snapshot.lastServiceDate)}\` |`,
    `| Expiry threshold reached | \`${display(snapshot.warningLevelDays)} days\` |`,
    `| Problems | \`${snapshot.problems.length === 0 ? 'none' : snapshot.problems.map(display).join(', ')}\` |`,
    '',
    'The issue changes only when one of these significant signals changes. Daily timestamps and remaining-day counters are intentionally omitted.',
  ].join('\n');
  return { attention: needsAttention(report), fingerprint, marker: markerFor(report.territory, report.source), title, body, snapshot };
}

export async function synchronizeIssue(report, api) {
  const notice = buildNotice(report);
  const allIssues = await api.listIssues();
  const matches = allIssues
    .filter((issue) => issue.pull_request == null && String(issue.body ?? '').includes(notice.marker))
    .sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || a.number - b.number);

  if (!notice.attention) {
    const openIssues = matches.filter((issue) => issue.state === 'open');
    for (const issue of openIssues) await api.updateIssue(issue.number, { state: 'closed', state_reason: 'completed' });
    return { action: openIssues.length === 0 ? 'NO_OPEN_ISSUE' : 'CLOSED', issueNumber: openIssues[0]?.number ?? null, duplicatesClosed: Math.max(0, openIssues.length - 1) };
  }

  if (matches.length === 0) {
    const created = await api.createIssue({ title: notice.title, body: notice.body });
    return { action: 'CREATED', issueNumber: created.number, duplicatesClosed: 0 };
  }

  const canonical = matches[0];
  const duplicates = matches.slice(1).filter((issue) => issue.state === 'open');
  const alreadyCurrent = canonical.state === 'open' && String(canonical.body ?? '').includes(fingerprintMarker(notice.fingerprint));
  if (!alreadyCurrent) await api.updateIssue(canonical.number, { title: notice.title, body: notice.body, state: 'open' });
  for (const duplicate of duplicates) await api.updateIssue(duplicate.number, { state: 'closed', state_reason: 'not_planned' });
  return { action: alreadyCurrent ? 'UNCHANGED' : 'UPDATED', issueNumber: canonical.number, duplicatesClosed: duplicates.length };
}

const retryableStatus = (status) => status === 429 || status >= 500;
const wait = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));

export function createGitHubApi({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch, sleep = wait, maximumAttempts = 3 } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY is invalid');
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const request = async (method, path, body) => {
    let lastError;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
          method,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) return response.status === 204 ? null : response.json();
        const message = (await response.text()).slice(0, 300);
        lastError = new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}: ${message}`);
        if (!retryableStatus(response.status) || attempt === maximumAttempts) throw lastError;
      } catch (error) {
        lastError = error;
        if (attempt === maximumAttempts || (error?.message ?? '').includes('HTTP 4')) throw error;
      }
      await sleep(250 * (2 ** (attempt - 1)));
    }
    throw lastError;
  };
  return {
    async listIssues() {
      const issues = [];
      for (let page = 1; page <= 10; page += 1) {
        const batch = await request('GET', `/issues?state=all&per_page=100&page=${page}`);
        issues.push(...batch);
        if (batch.length < 100) return issues;
      }
      throw new Error('issue scan exceeded 1000 entries');
    },
    createIssue: (body) => request('POST', '/issues', body),
    updateIssue: (number, body) => request('PATCH', `/issues/${number}`, body),
  };
}

export async function synchronizeReportFile(reportPath, api, resultPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const result = await synchronizeIssue(report, api);
  if (resultPath) writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const reportPath = resolve(args.get('--report') ?? '');
  if (!args.has('--report')) throw new Error('--report is required');
  const resultPath = args.has('--out') ? resolve(args.get('--out')) : null;
  const api = createGitHubApi({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL });
  const result = await synchronizeReportFile(reportPath, api, resultPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`sync-monitor-issue: ${error.message}`);
    process.exitCode = 1;
  });
}
