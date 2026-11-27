// Runs the real deployment script against a fake docker and a local fake of OTP, the Journey Service and the GitHub API.
// It proves the script's decisions and its restore path; it cannot prove anything about the real host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const slashes = (path) => path.replaceAll('\\', '/');
const script = slashes(fileURLToPath(new URL('../deploy/oracle/helekh-graph-deploy.sh', import.meta.url)));
const fakeDocker = slashes(fileURLToPath(new URL('./deploy/fake-docker.sh', import.meta.url)));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TODAY = '2026-12-01';
const fp = (letter) => letter.repeat(64);

function graphRelease(port, { content = 'NEW-GRAPH', letter = 'a', usableUntil = '2027-01-10', runId = 500, served = content, release = {}, manifest: change = () => {} } = {}) {
  const tag = `otp-graph-milano-test-${fp(letter)}`;
  const manifest = {
    schema: 'otp-graph-manifest-v2', territory: 'milano-test', buildFingerprint: fp(letter), builtAtUtc: '2026-12-01T01:00:00.000Z', workflow: { runId: String(runId) },
    gtfsValidity: { verdict: 'PASS' }, routingCheck: { verdict: 'PASS', itinerariesWithTransit: 4 }, usableUntil,
    graph: { sha256: sha(content), bytes: Buffer.byteLength(content), compressed: { sha256: sha(content), bytes: Buffer.byteLength(content) } },
  };
  change(manifest);
  const asset = (name) => ({ name, browser_download_url: `http://127.0.0.1:${port}/assets/${tag}/${name}` });
  return {
    entry: { tag_name: tag, draft: false, prerelease: false, published_at: `2026-12-01T0${runId % 10}:00:00Z`, assets: [asset('manifest.json'), asset('graph.obj.zst')], ...release },
    files: { [`/assets/${tag}/manifest.json`]: JSON.stringify(manifest), [`/assets/${tag}/graph.obj.zst`]: served },
  };
}

async function host(t, { oldContent = 'OLD-GRAPH', oldUntil = '2026-12-20', releases = [{}], untrusted = [], adopt = true } = {}) {
  const directory = slashes(mkdtempSync(join(tmpdir(), 'helekh-deploy-')));
  const fake = `${directory}/docker-state`;
  const state = `${directory}/state`;
  const active = `${directory}/graph.obj`;
  mkdirSync(fake);
  mkdirSync(state);
  writeFileSync(active, oldContent);
  writeFileSync(`${fake}/loaded`, oldContent);
  for (const name of ['helekh-otp', 'helekh-journey']) {
    writeFileSync(`${fake}/${name}.running`, '');
    writeFileSync(`${fake}/${name}.started`, '2026-11-18T10:43:14Z');
    writeFileSync(`${fake}/${name}.env`, 'JOURNEY_SERVICE_MODE=PROTECTED\n');
  }
  const requests = [];
  let published = [];
  let files = {};
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    requests.push(`${request.method} ${url.pathname}`);
    const loaded = existsSync(`${fake}/loaded`) ? readFileSync(`${fake}/loaded`, 'utf8') : '';
    const up = existsSync(`${fake}/helekh-otp.running`) && !loaded.includes('BROKEN-LOAD');
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (url.pathname === '/otp/actuators/health') return send(up ? 200 : 503, {});
      if (url.pathname === '/otp/gtfs/v1') {
        const mode = loaded.includes('BROKEN-OTP-ROUTE') ? 'WALK' : 'BUS';
        return send(up ? 200 : 503, { data: { planConnection: { edges: [{ node: { legs: [{ mode: 'WALK' }, { mode }] } }] } } });
      }
      if (url.pathname === '/health') return send(200, { status: 'ok' });
      if (url.pathname === '/journey-intelligence/session') return send(200, { token: 'test-token' });
      if (url.pathname === '/journey-intelligence/outbound-alternatives') {
        const mode = loaded.includes('BROKEN-JOURNEY') ? 'Walk' : 'Metro';
        requests.push(`arriveBy ${JSON.parse(body).arriveByIso}`);
        return send(up && request.headers.authorization === 'Bearer test-token' ? 200 : 503, { contractVersion: '1.7', alternatives: [{ legs: [{ mode: 'Walk' }, { mode }] }] });
      }
      if (url.pathname.endsWith('/releases')) return send(200, published);
      const run = /\/actions\/runs\/(\d+)$/.exec(url.pathname);
      if (run) {
        return send(200, { conclusion: untrusted.includes(Number(run[1])) ? 'failure' : 'success', head_branch: 'main', path: '.github/workflows/orchestrate-graph-build.yml', repository: { full_name: 'Moov3nt/helekh-otp-graph-build' } });
      }
      return files[url.pathname] === undefined ? send(404, {}) : send(200, files[url.pathname]);
    });
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  const { port } = server.address();
  const built = releases.map((options) => graphRelease(port, options));
  published = built.map((release) => release.entry);
  files = Object.assign({}, ...built.map((release) => release.files));
  t.after(() => { server.close(); rmSync(directory, { recursive: true, force: true }); });
  chmodSync(fakeDocker, 0o755);

  const run = (args, env = {}) => new Promise((accept) => {
    const child = spawn(bash, [script, ...args], {
      env: {
        ...process.env, MSYS_NO_PATHCONV: '1', HELEKH_DEPLOY_CONFIG: `${directory}/none.env`, DEPLOY_ENABLED: 'true', ACTIVE_GRAPH: active, STATE_DIR: state,
        OTP_URL: `http://127.0.0.1:${port}`, JOURNEY_URL: `http://127.0.0.1:${port}`, GITHUB_API: `http://127.0.0.1:${port}`, DOCKER: fakeDocker,
        FAKE_STATE: fake, FAKE_ACTIVE_GRAPH: active, ZSTD_DECOMPRESS: 'cat', HEALTH_TIMEOUT: '2', HEALTH_INTERVAL: '1', TODAY, ...env,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => accept({ code, output }));
  });
  const api = {
    directory, fake, state, active, requests, run,
    graph: () => readFileSync(active, 'utf8'),
    loaded: () => readFileSync(`${fake}/loaded`, 'utf8'),
    stops: () => (existsSync(`${fake}/calls.log`) ? readFileSync(`${fake}/calls.log`, 'utf8') : '').split('\n').filter((line) => line.startsWith('stop ')).length,
    manifest: () => JSON.parse(readFileSync(`${state}/active-manifest.json`, 'utf8')),
  };
  if (adopt) {
    // the manifest of the graph installed by hand is the older schema
    writeFileSync(`${directory}/old.json`, JSON.stringify({ schema: 'otp-graph-manifest-v1', usableUntil: oldUntil, graph: { sha256: sha(oldContent) } }));
    const adopted = await run(['adopt', `${directory}/old.json`]);
    assert.equal(adopted.code, 0, adopted.output);
  }
  return api;
}

const untouched = (h, result) => {
  assert.equal(h.graph(), 'OLD-GRAPH', result.output);
  assert.equal(h.stops(), 0, result.output);
};

test('check reports the candidate and changes nothing', async (t) => {
  const h = await host(t);
  const result = await h.run(['check'], { DEPLOY_ENABLED: 'false' });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /candidate otp-graph-milano-test-a{64}/);
  untouched(h, result);
});

test('apply and rollback refuse while deployment is disabled', async (t) => {
  const h = await host(t);
  for (const command of ['apply', 'rollback']) {
    const result = await h.run([command], { DEPLOY_ENABLED: 'false' });
    assert.equal(result.code, 1, result.output);
    untouched(h, result);
  }
});

test('a qualified graph is installed, verified for real and recorded; a second run does nothing', async (t) => {
  const h = await host(t);
  const result = await h.run(['apply']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /DEPLOY PASS/);
  assert.equal(h.graph(), 'NEW-GRAPH');
  assert.equal(h.loaded(), 'NEW-GRAPH');
  assert.equal(h.manifest().graph.sha256, sha('NEW-GRAPH'));
  assert.equal(readFileSync(`${h.state}/backups/graph-${sha('OLD-GRAPH')}.obj`, 'utf8'), 'OLD-GRAPH');
  assert.ok(!existsSync(`${h.state}/in-progress`));
  assert.ok(h.requests.includes('arriveBy 2026-12-02T20:00:00+01:00'), h.requests.join('\n'));
  const again = await h.run(['apply']);
  assert.equal(again.code, 0, again.output);
  assert.match(again.output, /nothing to install/);
  assert.equal(h.stops(), 1);
});

for (const [name, content] of [['does not load', 'NEW-BROKEN-LOAD'], ['does not route in OTP', 'NEW-BROKEN-OTP-ROUTE'], ['does not route through Journey', 'NEW-BROKEN-JOURNEY']]) {
  test(`a graph that ${name} is replaced by the previous one and never retried`, async (t) => {
    const h = await host(t, { releases: [{ content }] });
    const result = await h.run(['apply']);
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /ROLLBACK PASS/);
    assert.equal(h.graph(), 'OLD-GRAPH');
    assert.equal(h.loaded(), 'OLD-GRAPH');
    assert.equal(h.manifest().graph.sha256, sha('OLD-GRAPH'));
    assert.ok(!existsSync(`${h.state}/in-progress`));
    const again = await h.run(['apply']);
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /quarantined/);
    assert.equal(h.stops(), 2);
  });
}

test('a Journey Service that restarted during the change causes a restore', async (t) => {
  const h = await host(t);
  writeFileSync(`${h.fake}/journey_restarts_with_new_graph`, '');
  const result = await h.run(['apply']);
  assert.equal(result.code, 2, result.output);
  assert.equal(h.graph(), 'OLD-GRAPH');
});

test('when the restore cannot be proven the run says so and keeps the marker', async (t) => {
  const h = await host(t);
  writeFileSync(`${h.fake}/start_fails`, '');
  const result = await h.run(['apply']);
  assert.equal(result.code, 3, result.output);
  assert.match(result.output, /manual recovery required/);
  assert.ok(existsSync(`${h.state}/in-progress`));
  assert.equal(h.graph(), 'OLD-GRAPH');
});

test('an interrupted deployment is recovered before anything else', async (t) => {
  const h = await host(t);
  mkdirSync(`${h.state}/backups`);
  writeFileSync(`${h.state}/backups/graph-${sha('OLD-GRAPH')}.obj`, 'OLD-GRAPH');
  writeFileSync(`${h.state}/backups/graph-${sha('OLD-GRAPH')}.json`, readFileSync(`${h.state}/active-manifest.json`));
  writeFileSync(h.active, 'NEW-GRAPH'); // power lost after the swap
  writeFileSync(`${h.state}/in-progress`, `${sha('OLD-GRAPH')} 2026-12-20 ${sha('NEW-GRAPH')}\n`);
  const refused = await h.run(['check']);
  assert.equal(refused.code, 1, refused.output);
  const result = await h.run(['apply']);
  assert.equal(result.code, 2, result.output);
  assert.equal(h.graph(), 'OLD-GRAPH');
  assert.ok(!existsSync(`${h.state}/in-progress`));
});

test('unqualified, older, expired, unpublished or untrusted releases are never installed', async (t) => {
  const releases = [
    { letter: 'b', runId: 501, manifest: (m) => { m.routingCheck.verdict = 'FAIL'; } },
    { letter: 'c', runId: 502, manifest: (m) => { m.routingCheck.itinerariesWithTransit = 0; } },
    { letter: 'd', runId: 503, usableUntil: '2026-12-10' },
    { letter: 'e', runId: 504, usableUntil: TODAY },
    { letter: 'f', runId: 505 }, // its build run did not succeed
    { letter: '1', runId: 506, release: { draft: true } },
    { letter: '2', runId: 507, release: { prerelease: true } },
    { letter: '3', runId: 508, manifest: (m) => { m.buildFingerprint = fp('4'); } },
  ];
  const h = await host(t, { releases: releases.slice(0, 5), untrusted: [505] });
  const result = await h.run(['apply']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /nothing to install/);
  untouched(h, result);
  const other = await host(t, { releases: releases.slice(5) });
  const second = await other.run(['apply']);
  assert.match(second.output, /nothing to install/);
  untouched(other, second);
});

test('among qualified graphs the one covering the furthest wins', async (t) => {
  const h = await host(t, { releases: [{ letter: 'b', runId: 501, content: 'NEW-SHORT', usableUntil: '2026-12-28' }, { letter: 'c', runId: 502, content: 'NEW-LONG', usableUntil: '2027-02-01' }] });
  const result = await h.run(['apply']);
  assert.equal(result.code, 0, result.output);
  assert.equal(h.graph(), 'NEW-LONG');
});

test('a download that differs from its manifest stops before the service is touched', async (t) => {
  const h = await host(t, { releases: [{ served: 'NEW-GRAPX' }] });
  const result = await h.run(['apply']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /differs from the manifest/);
  untouched(h, result);
});

test('nothing is changed on a service that is already unhealthy', async (t) => {
  const h = await host(t, { oldContent: 'OLD-BROKEN-JOURNEY' });
  const result = await h.run(['apply']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /not healthy before the change/);
  assert.equal(h.stops(), 0);
});

test('an expired active graph can still be replaced', async (t) => {
  const h = await host(t, { oldContent: 'OLD-BROKEN-JOURNEY', oldUntil: '2026-11-30' });
  const result = await h.run(['apply']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /DEGRADED/);
  assert.equal(h.graph(), 'NEW-GRAPH');
});

test('manual rollback restores the previous graph and keeps it', async (t) => {
  const h = await host(t);
  assert.equal((await h.run(['apply'])).code, 0);
  const result = await h.run(['rollback']);
  assert.equal(result.code, 0, result.output);
  assert.equal(h.graph(), 'OLD-GRAPH');
  assert.equal(h.manifest().graph.sha256, sha('OLD-GRAPH'));
  const next = await h.run(['apply']);
  assert.equal(next.code, 0, next.output);
  assert.equal(h.graph(), 'OLD-GRAPH');
});

test('an unrecorded or changed active graph is refused', async (t) => {
  const h = await host(t, { adopt: false });
  assert.match((await h.run(['apply'])).output, /unknown active graph/);
  writeFileSync(`${h.directory}/wrong.json`, JSON.stringify({ usableUntil: '2026-12-20', graph: { sha256: sha('something else') } }));
  assert.equal((await h.run(['adopt', `${h.directory}/wrong.json`])).code, 1);
  assert.equal(h.stops(), 0);
});

test('a Journey Service that reads a graph manifest is refused until the script supports it', async (t) => {
  const h = await host(t);
  writeFileSync(`${h.fake}/helekh-journey.env`, 'JOURNEY_SERVICE_OTP_GRAPH_MANIFEST_PATH=/var/lib/x.json\n');
  const result = await h.run(['apply']);
  assert.equal(result.code, 1, result.output);
  untouched(h, result);
});
