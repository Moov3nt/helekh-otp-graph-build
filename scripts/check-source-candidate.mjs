// Observe-only classifier for one candidate source. It never edits sources.json, creates releases or starts builds.
// GTFS archive integrity is checked with the runner's `unzip`; effective service is delegated to check-gtfs-validity.mjs.
//
// node scripts/check-source-candidate.mjs --sources territories/<territory>/sources.json
//   --monitor territories/<territory>/monitor.json --source gtfs --download-status available
//   --candidate work/monitor/gtfs.zip --out meta/source-candidate-report.json
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const need = (name) => args.get(name) ?? (console.error(`check-source-candidate: ${name} is required`), process.exit(1));
const loadJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const shaPattern = /^[0-9a-f]{64}$/;

const sourcesPath = resolve(need('--sources'));
const monitorPath = resolve(need('--monitor'));
const sourceKey = need('--source');
const downloadStatus = need('--download-status');
const outputPath = resolve(need('--out'));
const today = args.get('--today') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const checkedAtUtc = args.get('--checked-at') ?? new Date().toISOString();
const downloadError = args.get('--download-error') ?? null;

if (!['available', 'unavailable'].includes(downloadStatus)) throw new Error('--download-status must be available or unavailable');
if (!dayPattern.test(today)) throw new Error('--today must be YYYY-MM-DD');
if (sourceKey !== 'gtfs') throw new Error(`source '${sourceKey}' is not supported yet`);

const sources = loadJson(sourcesPath);
const monitor = loadJson(monitorPath);
if (sources.territory !== monitor.territory) throw new Error('sources and monitor territory differ');
const source = sources[sourceKey];
const policy = monitor[sourceKey];
if (source == null || policy == null || policy.enabled !== true) throw new Error(`source '${sourceKey}' is not configured and enabled`);
if (!shaPattern.test(source.sha256 ?? '')) throw new Error('the pinned source SHA-256 is invalid');

const normalizeUrl = (value) => String(value ?? '').trim().replace(/\/$/, '');
const approvedLicense = (policy.approvedLicenses ?? []).find((candidate) =>
  candidate.name === source.license && normalizeUrl(candidate.url) === normalizeUrl(source.licenseUrl));
const license = {
  verdict: approvedLicense === undefined ? 'UNKNOWN' : 'APPROVED',
  id: approvedLicense?.id ?? null,
  declaredName: source.license ?? null,
  declaredUrl: source.licenseUrl ?? null,
};

const asDayNumber = (isoDay) => Math.floor(Date.UTC(+isoDay.slice(0, 4), +isoDay.slice(5, 7) - 1, +isoDay.slice(8, 10)) / 86400000);
const expiry = (lastServiceDate) => {
  if (lastServiceDate == null || !dayPattern.test(lastServiceDate)) return { daysRemaining: null, warningLevelDays: null };
  const daysRemaining = asDayNumber(lastServiceDate) - asDayNumber(today);
  const thresholds = [...(policy.expiryWarningDays ?? [])].filter(Number.isInteger).filter((n) => n >= 0).sort((a, b) => a - b);
  const warningLevelDays = thresholds.find((threshold) => daysRemaining <= threshold) ?? null;
  return { daysRemaining, warningLevelDays };
};

const fileSha256 = (path) => new Promise((accept, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => accept(hash.digest('hex')));
});

function findUnzip() {
  const candidates = [
    process.env.UNZIP,
    'unzip',
    process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'unzip.exe') : null,
  ].filter(Boolean);
  for (const command of candidates) {
    const probe = spawnSync(command, ['-v'], { encoding: 'utf8', windowsHide: true });
    if (probe.error == null) return command;
  }
  throw new Error('unzip is required but was not found');
}

function runGtfsValidation(candidateZip) {
  const unzip = findUnzip();
  const integrity = spawnSync(unzip, ['-tq', candidateZip], { encoding: 'utf8', windowsHide: true });
  if (integrity.status !== 0) return { integrity: 'FAIL', validity: null, problems: ['ZIP_INVALID'] };

  const work = mkdtempSync(join(tmpdir(), 'helekh-source-check-'));
  try {
    const listing = spawnSync(unzip, ['-Z1', candidateZip], { encoding: 'utf8', windowsHide: true });
    if (listing.status !== 0) return { integrity: 'FAIL', validity: null, problems: ['ZIP_DIRECTORY_UNREADABLE'] };
    const names = new Set(listing.stdout.split(/\r?\n/).filter(Boolean));
    const selected = ['calendar.txt', 'calendar_dates.txt', 'trips.txt', 'feed_info.txt'].filter((name) => names.has(name));
    if (!names.has('trips.txt') || (!names.has('calendar.txt') && !names.has('calendar_dates.txt'))) {
      return { integrity: 'PASS', validity: null, problems: ['GTFS_REQUIRED_FILES_MISSING'] };
    }
    const extracted = spawnSync(unzip, ['-oq', candidateZip, ...selected, '-d', work], { encoding: 'utf8', windowsHide: true });
    if (extracted.status !== 0) return { integrity: 'FAIL', validity: null, problems: ['ZIP_EXTRACTION_FAILED'] };

    const validityPath = join(work, 'validity.json');
    const validatorPath = resolve(dirname(fileURLToPath(import.meta.url)), 'check-gtfs-validity.mjs');
    const validatorArgs = [validatorPath, '--dir', work, '--timezone', sources.timezone, '--today', today,
      '--min-future-days', String(policy.minimumFutureDays ?? 1), '--out', validityPath];
    const mustCoverUntil = args.get('--must-cover-until') ?? '';
    if (mustCoverUntil !== '') validatorArgs.push('--must-cover-until', mustCoverUntil);
    const validation = spawnSync(process.execPath, validatorArgs, { encoding: 'utf8', windowsHide: true });
    const validity = existsSync(validityPath) ? loadJson(validityPath) : null;
    if (validation.status !== 0) return { integrity: 'PASS', validity, problems: validity?.problems?.length ? validity.problems : ['GTFS_VALIDATOR_FAILED'] };
    return { integrity: 'PASS', validity, problems: [] };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

let candidate = { sha256: null, bytes: null, change: 'UNKNOWN' };
let integrity = 'NOT_RUN';
let validity = null;
let problems = [];
let state;

if (downloadStatus === 'unavailable') {
  state = 'UNAVAILABLE';
  problems.push('SOURCE_UNAVAILABLE');
} else {
  const candidatePath = resolve(need('--candidate'));
  if (!existsSync(candidatePath)) throw new Error('candidate file does not exist');
  candidate = {
    sha256: await fileSha256(candidatePath),
    bytes: statSync(candidatePath).size,
    change: null,
  };
  candidate.change = candidate.sha256 === source.sha256 ? 'UNCHANGED' : 'UPDATED';

  if (license.verdict !== 'APPROVED') {
    state = 'LICENSE_UNKNOWN';
    problems.push('LICENSE_NOT_APPROVED');
  } else {
    const checked = runGtfsValidation(candidatePath);
    integrity = checked.integrity;
    validity = checked.validity;
    problems.push(...checked.problems);
    const lastServiceDate = validity?.effective?.lastServiceDate ?? null;
    const expiryStatus = expiry(lastServiceDate);
    if (integrity !== 'PASS' || validity?.verdict !== 'PASS') {
      state = lastServiceDate !== null && lastServiceDate < today ? 'EXPIRED' : 'UPDATED_INVALID';
    } else if (expiryStatus.daysRemaining < 0) {
      state = 'EXPIRED';
      problems.push('GTFS_EXPIRED');
    } else if (expiryStatus.warningLevelDays !== null) {
      state = 'EXPIRING';
    } else {
      state = candidate.change === 'UNCHANGED' ? 'UNCHANGED' : 'UPDATED_VALID';
    }
  }
}

const lastServiceDate = validity?.effective?.lastServiceDate ?? source.validUntil ?? null;
const report = {
  schema: 'source-candidate-report-v1',
  territory: sources.territory,
  source: sourceKey,
  checkedAtUtc,
  referenceDate: today,
  state,
  acquisition: {
    status: downloadStatus === 'available' ? 'AVAILABLE' : 'UNAVAILABLE',
    publisherUrl: source.publisherUrl ?? null,
    error: downloadStatus === 'unavailable' ? downloadError : null,
  },
  current: { sha256: source.sha256, bytes: source.bytes, validUntil: source.validUntil ?? null },
  candidate,
  integrity: { zip: integrity },
  license,
  validity,
  expiry: { lastServiceDate, ...expiry(lastServiceDate) },
  problems: [...new Set(problems)],
  observeOnly: { inputMutation: false, releaseCreated: false, buildRequested: false, deploymentRequested: false },
};

mkdirSync(dirname(outputPath), { recursive: true });
const text = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(outputPath, text);
process.stdout.write(text);
