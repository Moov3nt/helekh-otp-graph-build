import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '..', 'scripts', 'otp-smoke.mjs');
const place = (label, latitude, longitude) => ({ label, latitude, longitude });

async function runSmoke({ failSecond = false } = {}) {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/otp/actuators/health') {
      response.writeHead(200).end('{}');
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests += 1;
      const variables = JSON.parse(body).variables;
      const edges = failSecond && requests === 2 ? [] : [{ node: {
        start: variables.dateTime.earliestDeparture,
        end: variables.dateTime.earliestDeparture,
        legs: [{ mode: 'BUS', duration: 600, from: { name: variables.origin.label }, to: { name: variables.destination.label } }],
      } }];
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { planConnection: { edges } } }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const directory = mkdtempSync(join(tmpdir(), 'otp-smoke-'));
  const sources = join(directory, 'sources.json');
  const output = join(directory, 'result.json');
  writeFileSync(sources, JSON.stringify({
    territory: 'roma-test', timezone: 'Europe/Rome', smokes: [
      { origin: place('Termini', 41.9, 12.5), destination: place('Olimpico', 41.93, 12.45), localTime: '18:00' },
      { origin: place('Olimpico', 41.93, 12.45), destination: place('Termini', 41.9, 12.5), localTime: '23:00' },
    ],
  }));
  const address = server.address();
  const child = spawn(process.execPath, [script, '--base', `http://127.0.0.1:${address.port}`, '--sources', sources,
    '--last-service-date', '2026-12-31', '--today', '2026-11-23', '--started-at-epoch-ms', String(Date.now()), '--out', output]);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => child.on('exit', resolveExit));
  await new Promise((resolveClose) => server.close(resolveClose));
  return { exitCode, stderr, requests, result: JSON.parse(readFileSync(output, 'utf8')) };
}

test('one smoke cycle checks both Roma directions and records timings', async () => {
  const { exitCode, requests, result } = await runSmoke();
  assert.equal(exitCode, 0);
  assert.equal(requests, 2);
  assert.equal(result.schema, 'otp-smoke-result-v2');
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.checks.map((check) => [check.query.origin, check.query.destination, check.verdict]), [
    ['Termini', 'Olimpico', 'PASS'], ['Olimpico', 'Termini', 'PASS'],
  ]);
  assert.equal(result.responseMilliseconds.length, 2);
  assert.ok(result.startupMilliseconds >= 0);
});

test('the cycle fails when either representative direction has no transit itinerary', async () => {
  const { exitCode, result } = await runSmoke({ failSecond: true });
  assert.equal(exitCode, 2);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.checks.map((check) => check.verdict), ['PASS', 'FAIL']);
});
