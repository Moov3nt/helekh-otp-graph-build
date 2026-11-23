import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { planConnection: {
        searchDateTime: variables.dateTime.earliestDeparture,
        pageInfo: { searchWindowUsed: 'PT3H' },
        routingErrors: failSecond && requests === 2 ? [{ code: 'NO_TRANSIT_CONNECTION', description: 'No transit connection', inputField: null }] : [],
        edges,
      } } }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const directory = mkdtempSync(join(tmpdir(), 'otp-smoke-'));
  const sources = join(directory, 'sources.json');
  const output = join(directory, 'result.json');
  const diagnostics = join(directory, 'graphql');
  writeFileSync(sources, JSON.stringify({
    territory: 'roma-test', timezone: 'Europe/Rome', smokes: [
      { name: 'central', origin: place('Termini', 41.9, 12.5), destination: place('Colosseo', 41.89, 12.49), localTime: '12:00' },
      { name: 'same-line', origin: place('Plebiscito', 41.89, 12.48), destination: place('Ponte Vittorio', 41.90, 12.46), localTime: '11:35' },
      { name: 'daytime', origin: place('Termini', 41.9, 12.5), destination: place('Olimpico', 41.93, 12.45), localTime: '12:00' },
      { origin: place('Termini', 41.9, 12.5), destination: place('Olimpico', 41.93, 12.45), localTime: '18:00' },
      { origin: place('Olimpico', 41.93, 12.45), destination: place('Termini', 41.9, 12.5), localTime: '23:00' },
    ],
  }));
  const address = server.address();
  const child = spawn(process.execPath, [script, '--base', `http://127.0.0.1:${address.port}`, '--sources', sources,
    '--last-service-date', '2026-12-31', '--today', '2026-11-23', '--started-at-epoch-ms', String(Date.now()), '--out', output,
    '--diagnostics-dir', diagnostics]);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => child.on('exit', resolveExit));
  await new Promise((resolveClose) => server.close(resolveClose));
  return { exitCode, stderr, requests, result: JSON.parse(readFileSync(output, 'utf8')), diagnosticFiles: readdirSync(diagnostics) };
}

test('one diagnostic smoke cycle checks five Roma routes and preserves raw exchanges', async () => {
  const { diagnosticFiles, exitCode, requests, result } = await runSmoke();
  assert.equal(exitCode, 0);
  assert.equal(requests, 5);
  assert.equal(result.schema, 'otp-smoke-result-v2');
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.checks.map((check) => check.verdict), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  assert.equal(result.responseMilliseconds.length, 5);
  assert.equal(diagnosticFiles.filter((file) => file.endsWith('.request.json')).length, 5);
  assert.equal(diagnosticFiles.filter((file) => file.endsWith('.response.json')).length, 5);
  assert.equal(result.checks[0].searchWindowUsed, 'PT3H');
  assert.deepEqual(result.checks[0].routingErrors, []);
  assert.ok(result.startupMilliseconds >= 0);
});

test('the cycle fails when either representative direction has no transit itinerary', async () => {
  const { exitCode, result } = await runSmoke({ failSecond: true });
  assert.equal(exitCode, 2);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.checks.map((check) => check.verdict), ['PASS', 'FAIL', 'PASS', 'PASS', 'PASS']);
  assert.equal(result.checks[1].routingErrors[0].code, 'NO_TRANSIT_CONNECTION');
});
