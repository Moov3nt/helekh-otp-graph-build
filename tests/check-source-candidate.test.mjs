import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const classifier = join(root, 'scripts', 'check-source-candidate.mjs');
const fixtures = join(root, 'tests', 'fixtures', 'gtfs');
const fixedToday = '2026-11-20';
const fixedCheckedAt = '2026-11-20T09:00:00.000Z';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
};

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(contents);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function fixtureZip(name) {
  const directory = join(fixtures, name);
  return storedZip(Object.fromEntries(['calendar.txt', 'calendar_dates.txt', 'trips.txt', 'feed_info.txt']
    .map((file) => [file, readFileSync(join(directory, file))])));
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function baseMonitor() {
  return {
    schema: 'source-monitor-v1', territory: 'fixture',
    gtfs: {
      enabled: true, minimumFutureDays: 1, expiryWarningDays: [21, 14, 7],
      approvedLicenses: [{ id: 'CC-BY-4.0', name: 'Creative Commons Attribution 4.0 International (CC BY 4.0)', url: 'https://creativecommons.org/licenses/by/4.0/' }],
      download: { maximumAttempts: 3, connectTimeoutSeconds: 20, maximumTimeSeconds: 180, retryDelaySeconds: 5 },
    },
  };
}

function baseSources(currentSha, bytes, overrides = {}) {
  return {
    territory: 'fixture', timezone: 'Europe/Rome',
    gtfs: {
      publisherUrl: 'https://example.test/gtfs.zip', sha256: currentSha, bytes, validUntil: '2026-12-31',
      license: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', ...overrides,
    },
  };
}

function scenario({ fixture = 'valid', current = 'different', corrupted = false, sourceOverrides = {}, unavailable = false }) {
  const directory = mkdtempSync(join(tmpdir(), 'helekh-source-test-'));
  const candidate = join(directory, 'candidate.zip');
  const zip = corrupted ? Buffer.from('this is not a ZIP archive') : fixtureZip(fixture);
  if (!unavailable) writeFileSync(candidate, zip);
  const currentSha = current === 'same' ? sha256(zip) : '0'.repeat(64);
  const sourcesPath = join(directory, 'sources.json');
  const monitorPath = join(directory, 'monitor.json');
  const reportPath = join(directory, 'report.json');
  writeFileSync(sourcesPath, `${JSON.stringify(baseSources(currentSha, zip.length, sourceOverrides), null, 2)}\n`);
  writeFileSync(monitorPath, `${JSON.stringify(baseMonitor(), null, 2)}\n`);
  const sourceBefore = readFileSync(sourcesPath, 'utf8');
  const cli = [classifier, '--sources', sourcesPath, '--monitor', monitorPath, '--source', 'gtfs',
    '--download-status', unavailable ? 'unavailable' : 'available', '--today', fixedToday, '--checked-at', fixedCheckedAt,
    '--out', reportPath];
  if (unavailable) cli.push('--download-error', 'fixture-timeout'); else cli.push('--candidate', candidate);
  const result = spawnSync(process.execPath, cli, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(readFileSync(sourcesPath, 'utf8'), sourceBefore, 'the valid pinned input must remain byte-identical');
  assert.deepEqual(report.observeOnly, { inputMutation: false, releaseCreated: false, buildRequested: false, deploymentRequested: false });
  return { directory, report };
}

function stateTest(name, expected, options, assertions = () => {}) {
  test(name, () => {
    const { directory, report } = scenario(options);
    try {
      assert.equal(report.state, expected);
      assertions(report);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

stateTest('classifies an unchanged valid feed', 'UNCHANGED', { current: 'same' }, (report) => {
  assert.equal(report.integrity.zip, 'PASS');
  assert.equal(report.validity.verdict, 'PASS');
});

stateTest('classifies a new valid feed', 'UPDATED_VALID', { current: 'different' }, (report) => {
  assert.equal(report.candidate.change, 'UPDATED');
  assert.equal(report.license.verdict, 'APPROVED');
});

stateTest('rejects a corrupt ZIP', 'UPDATED_INVALID', { corrupted: true }, (report) => {
  assert.equal(report.integrity.zip, 'FAIL');
  assert.ok(report.problems.includes('ZIP_INVALID'));
});

stateTest('classifies an expired effective calendar', 'EXPIRED', { fixture: 'expired' }, (report) => {
  assert.equal(report.expiry.lastServiceDate, '2026-10-31');
  assert.ok(report.expiry.daysRemaining < 0);
});

stateTest('rejects a feed without trips on active services', 'UPDATED_INVALID', { fixture: 'no-effective-trips' }, (report) => {
  assert.equal(report.validity.effective.lastServiceDate, null);
  assert.ok(report.problems.some((problem) => problem.startsWith('NO_EFFECTIVE_SERVICE')));
});

stateTest('blocks a licence outside the approved policy', 'LICENSE_UNKNOWN', {
  sourceOverrides: { license: 'Unknown licence', licenseUrl: 'https://example.test/unknown' },
}, (report) => {
  assert.equal(report.license.verdict, 'UNKNOWN');
  assert.equal(report.integrity.zip, 'NOT_RUN');
});

stateTest('reports a temporarily unavailable source without changing the valid input', 'UNAVAILABLE', { unavailable: true }, (report) => {
  assert.equal(report.acquisition.error, 'fixture-timeout');
  assert.equal(report.candidate.sha256, null);
});

stateTest('warns when an otherwise valid feed approaches expiry', 'EXPIRING', { fixture: 'expiring', current: 'same' }, (report) => {
  assert.equal(report.expiry.daysRemaining, 10);
  assert.equal(report.expiry.warningLevelDays, 14);
});
