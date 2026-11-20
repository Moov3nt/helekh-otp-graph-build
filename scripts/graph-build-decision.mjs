#!/usr/bin/env node
// Deterministic OTP graph identity and build decision. Dependency-free (Node >= 18).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/;
const TERRITORY = /^[a-z0-9][a-z0-9-]{0,40}$/;
const BUILD_RECIPE = 'otp-cli-build-save-abort-on-unknown-config-v1';
const VERIFIED_SCHEMA = 'otp-graph-manifest-v2';
const IDENTITY_SCRIPTS = ['scripts/check-gtfs-validity.mjs', 'scripts/otp-smoke.mjs'];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (root, file) => readFileSync(resolve(root, file));
const json = (root, file) => JSON.parse(read(root, file).toString('utf8'));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSha(value, label) {
  if (!SHA256.test(value ?? '')) throw new Error(`${label} must be 64 lower-case hex digits`);
}

function computeIdentityFrom({ load, territory, heapGb = '12' }) {
  if (!TERRITORY.test(territory ?? '')) throw new Error('territory is invalid');
  if (!/^[0-9]{1,2}$/.test(String(heapGb)) || Number(heapGb) < 4 || Number(heapGb) > 13) throw new Error('heap-gb must be between 4 and 13');
  const loadJson = (file) => JSON.parse(load(file).toString('utf8'));
  const sources = loadJson(`territories/${territory}/sources.json`);
  const versions = loadJson('versions.json');
  const buildConfig = loadJson(`territories/${territory}/build-config.json`);
  const routerConfig = loadJson('config/router-config.json');
  const otpConfig = loadJson('config/otp-config.json');

  if (sources.territory !== territory) throw new Error('sources territory does not match the selected territory');
  if (buildConfig.transitModelTimeZone !== sources.timezone) throw new Error('build timezone does not match sources timezone');
  if (!Array.isArray(buildConfig.osm) || buildConfig.osm.length !== 1 || buildConfig.osm[0].source !== 'input/osm.pbf') throw new Error('build configuration must consume the pinned OSM input');
  if (!Array.isArray(buildConfig.transitFeeds) || buildConfig.transitFeeds.length !== 1 || buildConfig.transitFeeds[0].source !== 'input/gtfs.zip') throw new Error('build configuration must consume the pinned GTFS input');
  if (buildConfig.graph !== 'output/graph.obj') throw new Error('build configuration graph path is inconsistent with the existing pipeline');
  assertSha(sources.gtfs?.sha256, 'GTFS SHA-256');
  assertSha(sources.osm?.sha256, 'OSM SHA-256');
  assertSha(versions.otpJarSha256, 'OTP JAR SHA-256');
  if (!/^[0-9a-f]{32}$/.test(sources.osm?.md5 ?? '')) throw new Error('OSM publisher MD5 is invalid');
  if (!Number.isSafeInteger(sources.gtfs?.bytes) || sources.gtfs.bytes <= 0) throw new Error('GTFS byte size is invalid');
  if (!Number.isSafeInteger(sources.osm?.bytes) || sources.osm.bytes <= 0) throw new Error('OSM byte size is invalid');
  if (!Number.isSafeInteger(versions.otpJarBytes) || versions.otpJarBytes <= 0) throw new Error('OTP JAR byte size is invalid');
  if (sources.gtfs.mutable !== false || sources.osm.mutable !== false) throw new Error('graph inputs must be approved immutable snapshots');
  if (!sources.gtfs.url?.startsWith('https://') || !sources.osm.url?.startsWith('https://')) throw new Error('graph input URLs must use HTTPS');
  if (!versions.otpVersion || !versions.javaImage?.includes('@sha256:')) throw new Error('OTP version and digest-pinned Java image are required');

  const identity = {
    schema: 'otp-graph-fingerprint-v1',
    territory,
    software: {
      otpVersion: versions.otpVersion,
      otpJarSha256: versions.otpJarSha256,
      otpJarBytes: versions.otpJarBytes,
      javaImage: versions.javaImage,
    },
    inputs: {
      gtfs: { sha256: sources.gtfs.sha256, bytes: sources.gtfs.bytes },
      osm: { sha256: sources.osm.sha256, bytes: sources.osm.bytes, md5: sources.osm.md5 },
    },
    configuration: {
      build: buildConfig,
      router: routerConfig,
      otp: otpConfig,
    },
    builder: {
      recipe: BUILD_RECIPE,
      heapGigabytes: Number(heapGb),
      scripts: Object.fromEntries(IDENTITY_SCRIPTS.map((file) => [file, sha256(load(file))])),
    },
  };
  return { fingerprint: sha256(canonical(identity)), identity };
}

export function computeIdentity({ root = '.', territory, heapGb = '12' }) {
  return computeIdentityFrom({ load: (file) => read(root, file), territory, heapGb });
}

export function computeIdentityAtRevision({ root = '.', revision, territory, heapGb = '12' }) {
  const load = (file) => Buffer.from(execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'buffer' }));
  return computeIdentityFrom({ load, territory, heapGb });
}

export function classifyChangedFiles(changed, territory) {
  const exact = new Set([
    'versions.json',
    'config/otp-config.json',
    'config/router-config.json',
    `territories/${territory}/build-config.json`,
    `territories/${territory}/sources.json`,
    ...IDENTITY_SCRIPTS,
  ]);
  return changed.filter((file) => exact.has(file.replaceAll('\\', '/')));
}

export function relevantDiff({ root = '.', before, after = 'HEAD', territory, currentFingerprint, heapGb = '12' }) {
  if (!before) return { relevant: true, reason: 'no comparison revision supplied', files: [] };
  const output = execFileSync('git', ['diff', '--name-only', before, after, '--'], { cwd: root, encoding: 'utf8' });
  const changed = output.split(/\r?\n/).filter(Boolean);
  const files = classifyChangedFiles(changed, territory);
  if (files.length === 0) return { relevant: false, reason: 'only non-graph files changed', files };
  const previousFingerprint = computeIdentityAtRevision({ root, revision: before, territory, heapGb }).fingerprint;
  if (previousFingerprint === currentFingerprint) return { relevant: false, reason: 'changed metadata does not alter the graph fingerprint', files, previousFingerprint };
  return { relevant: true, reason: 'the graph fingerprint changed', files, previousFingerprint };
}

function verifyRecord(directory, expectedFingerprint) {
  try {
    const manifestPath = join(directory, 'manifest.json');
    const smokePath = join(directory, 'routing-check.json');
    if (!existsSync(manifestPath) || !existsSync(smokePath)) return { valid: false, reason: 'record is missing manifest or routing check' };
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const smoke = JSON.parse(readFileSync(smokePath, 'utf8'));
    if (manifest.buildFingerprint !== expectedFingerprint) return { valid: false, ignored: true, reason: 'manifest fingerprint differs' };
    if (manifest.schema !== VERIFIED_SCHEMA) return { valid: false, reason: 'manifest schema is not verification-capable' };
    if (manifest.routingCheck?.verdict !== 'PASS' || smoke.verdict !== 'PASS') return { valid: false, reason: 'routing smoke test did not pass' };
    assertSha(manifest.graph?.sha256, 'graph SHA-256');
    assertSha(manifest.graph?.compressed?.sha256, 'compressed graph SHA-256');
    if (manifest.graph?.bytes <= 50_000_000 || manifest.graph?.compressed?.bytes <= 0) return { valid: false, reason: 'graph sizes are not credible' };
    return { valid: true, manifest };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

export function inspectRecords({ artifactsDir, fingerprint }) {
  if (!artifactsDir || !existsSync(artifactsDir)) return { verified: null, invalid: [] };
  const directories = existsSync(join(artifactsDir, 'manifest.json'))
    ? [artifactsDir]
    : readdirSync(artifactsDir).map((name) => join(artifactsDir, name)).filter((path) => statSync(path).isDirectory());
  const invalid = [];
  for (const directory of directories) {
    const result = verifyRecord(directory, fingerprint);
    if (result.valid) return { verified: { directory: basename(directory), manifest: result.manifest }, invalid };
    if (!result.ignored) invalid.push({ directory: basename(directory), reason: result.reason });
  }
  return { verified: null, invalid };
}

export function decide({ identityResult, diff, records, inputError = null }) {
  if (inputError) return { decision: 'BLOCKED', reason: inputError };
  if (!diff.relevant) return { decision: 'NO_RELEVANT_CHANGE', reason: diff.reason };
  if (records.verified) return { decision: 'ALREADY_BUILT', reason: 'a verified graph exists for this fingerprint' };
  if (records.invalid.length > 0) return { decision: 'BLOCKED', reason: 'matching or candidate verification records exist but are not verifiable' };
  return { decision: 'BUILD_REQUIRED', reason: 'relevant inputs changed and no verified graph has this fingerprint' };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = resolve(args.get('--root') ?? '.');
  const territory = args.get('--territory');
  const out = args.get('--out');
  const mode = args.get('--mode') ?? 'evaluate';
  let identityResult;
  let diff = { relevant: true, reason: 'fingerprint requested directly', files: [] };
  let records = { verified: null, invalid: [] };
  let inputError = null;
  try {
    identityResult = computeIdentity({ root, territory, heapGb: args.get('--heap-gb') ?? '12' });
    if (mode === 'evaluate') {
      diff = relevantDiff({ root, before: args.get('--before'), after: args.get('--after') ?? 'HEAD', territory, currentFingerprint: identityResult.fingerprint, heapGb: args.get('--heap-gb') ?? '12' });
      records = inspectRecords({ artifactsDir: args.get('--artifacts-dir'), fingerprint: identityResult.fingerprint });
    }
  } catch (error) {
    inputError = error.message;
  }
  if (args.get('--artifact-set-error')) inputError = args.get('--artifact-set-error');
  const result = {
    schema: 'otp-graph-build-decision-v1',
    territory,
    fingerprint: identityResult?.fingerprint ?? null,
    identity: identityResult?.identity ?? null,
    relevantChange: diff,
    artifactVerification: records,
    ...decide({ identityResult, diff, records, inputError }),
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (out) writeFileSync(out, output);
  process.stdout.write(output);
  if (result.decision === 'BLOCKED') process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
