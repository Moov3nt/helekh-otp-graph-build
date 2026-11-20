import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  classifyChangedFiles,
  computeIdentity,
  decide,
  inspectRecords,
} from '../scripts/graph-build-decision.mjs';

const repository = resolve(import.meta.dirname, '..');
const relevantFiles = [
  'versions.json',
  'config/otp-config.json',
  'config/router-config.json',
  'territories/milano-test/build-config.json',
  'territories/milano-test/sources.json',
  'scripts/check-gtfs-validity.mjs',
  'scripts/otp-smoke.mjs',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'otp-decision-'));
  for (const file of relevantFiles) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repository, file), target);
  }
  return root;
}

function mutateJson(root, file, mutate) {
  const path = join(root, file);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const identity = (root) => computeIdentity({ root, territory: 'milano-test', heapGb: '12' });

function record(root, fingerprint, overrides = {}) {
  const directory = join(root, 'records', 'mock-record');
  mkdirSync(directory, { recursive: true });
  const manifest = {
    schema: 'otp-graph-manifest-v2',
    buildFingerprint: fingerprint,
    graph: {
      bytes: 50_000_001,
      sha256: 'a'.repeat(64),
      compressed: { bytes: 1, sha256: 'b'.repeat(64) },
    },
    routingCheck: { verdict: 'PASS' },
    ...overrides,
  };
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(directory, 'routing-check.json'), `${JSON.stringify({ verdict: 'PASS' })}\n`);
  return join(root, 'records');
}

test('1. a newly approved GTFS changes the fingerprint and requires a build', () => {
  const root = fixture();
  const before = identity(root).fingerprint;
  mutateJson(root, 'territories/milano-test/sources.json', (value) => { value.gtfs.sha256 = '1'.repeat(64); });
  assert.notEqual(identity(root).fingerprint, before);
  assert.equal(decide({ diff: { relevant: true }, records: { verified: null, invalid: [] } }).decision, 'BUILD_REQUIRED');
});

test('2. unchanged GTFS metadata does not change graph identity', () => {
  const root = fixture();
  const before = identity(root).fingerprint;
  mutateJson(root, 'territories/milano-test/sources.json', (value) => { value.gtfs.note = 'documentation only'; });
  assert.equal(identity(root).fingerprint, before);
  assert.equal(decide({ diff: { relevant: false, reason: 'same fingerprint' }, records: { verified: null, invalid: [] } }).decision, 'NO_RELEVANT_CHANGE');
});

test('3. documentation-only changes are not relevant', () => {
  assert.deepEqual(classifyChangedFiles(['README.md', 'NOTICE.md'], 'milano-test'), []);
});

test('4. a newly approved OSM changes the fingerprint', () => {
  const root = fixture();
  const before = identity(root).fingerprint;
  mutateJson(root, 'territories/milano-test/sources.json', (value) => { value.osm.sha256 = '2'.repeat(64); });
  assert.notEqual(identity(root).fingerprint, before);
});

test('5. effective OTP configuration changes the fingerprint', () => {
  const root = fixture();
  const before = identity(root).fingerprint;
  mutateJson(root, 'config/otp-config.json', (value) => { value.otpFeatures.GtfsGraphQlApi = false; });
  assert.notEqual(identity(root).fingerprint, before);
});

test('6. a graph-affecting validation script changes the fingerprint', () => {
  const root = fixture();
  const before = identity(root).fingerprint;
  const path = join(root, 'scripts/check-gtfs-validity.mjs');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n// fixture change\n`);
  assert.notEqual(identity(root).fingerprint, before);
});

test('7. a complete verified record yields ALREADY_BUILT', () => {
  const root = fixture();
  const fingerprint = identity(root).fingerprint;
  const records = inspectRecords({ artifactsDir: record(root, fingerprint), fingerprint });
  assert.equal(decide({ diff: { relevant: true }, records }).decision, 'ALREADY_BUILT');
});

test('8. an artifact with an unverifiable manifest yields BLOCKED', () => {
  const root = fixture();
  const fingerprint = identity(root).fingerprint;
  const recordsPath = record(root, fingerprint, { schema: 'otp-graph-manifest-v1' });
  const records = inspectRecords({ artifactsDir: recordsPath, fingerprint });
  assert.equal(decide({ diff: { relevant: true }, records }).decision, 'BLOCKED');
});

test('9. unverifiable input identity is rejected', () => {
  const root = fixture();
  mutateJson(root, 'territories/milano-test/sources.json', (value) => { value.gtfs.sha256 = 'unknown'; });
  assert.throws(() => identity(root), /GTFS SHA-256/);
});

test('10. incoherent territory configuration is rejected', () => {
  const root = fixture();
  mutateJson(root, 'territories/milano-test/build-config.json', (value) => { value.transitModelTimeZone = 'UTC'; });
  assert.throws(() => identity(root), /timezone/);
});

test('11. concurrent requests are serialized by territory and share the reusable build', () => {
  const workflow = readFileSync(join(repository, '.github/workflows/orchestrate-graph-build.yml'), 'utf8');
  assert.match(workflow, /group: otp-graph-orchestrator-\$\{\{ inputs\.territory \}\}/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/build-graph\.yml/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('12. failed builds cannot publish a verified record', () => {
  const workflow = readFileSync(join(repository, '.github/workflows/build-graph.yml'), 'utf8');
  assert.ok(workflow.indexOf('name: Build the graph') < workflow.indexOf('name: Publish verified fingerprint record'));
  assert.doesNotMatch(workflow, /Publish verified fingerprint record[\s\S]{0,200}if: always\(\)/);
});

test('13. failed smoke tests cannot publish a verified record', () => {
  const workflow = readFileSync(join(repository, '.github/workflows/build-graph.yml'), 'utf8');
  assert.ok(workflow.indexOf('name: Load the graph and route for real') < workflow.indexOf('name: Publish verified fingerprint record'));
  assert.match(workflow, /--smoke meta\/smoke\.json/);
  assert.match(workflow, /if \[\[ "\$status" -ne 0 \]\].*exit "\$status"/s);
});

test('14. Oracle or unrelated application changes are ignored', () => {
  assert.deepEqual(classifyChangedFiles(['oracle/schema.sql', 'android/app.gradle', 'journey-service/main.ts'], 'milano-test'), []);
});

test('15. the existing manual workflow remains available with its defaults', () => {
  const workflow = readFileSync(join(repository, '.github/workflows/build-graph.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /default: milano-test/);
  assert.match(workflow, /default: "12"/);
  assert.match(workflow, /default: "7"/);
  assert.match(workflow, /expected_build_fingerprint:[\s\S]*default: ""/);
});
