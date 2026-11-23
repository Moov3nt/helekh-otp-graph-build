// Real routing check against a running OTP 2.9 (graph loaded). Dependency-free (Node >= 18).
//
//   node otp-smoke.mjs --base http://127.0.0.1:8080 --sources territories/<t>/sources.json --last-service-date YYYY-MM-DD
//                      [--today YYYY-MM-DD] [--out result.json] [--diagnostics-dir directory]
//
// 1. waits for /otp/actuators/health to answer 200 (graph loaded);
// 2. asks the GraphQL planConnection for every configured smoke query (`smokes`, or the legacy single `smoke`), departing at each
//    configured local time on the first day that is inside the feed's service horizon (tomorrow, or today if tomorrow is past it);
// 3. passes only if every query returns at least one itinerary with at least one transit leg.
// The itineraries are real answers of the loaded graph; nothing is simulated. Exit 0 pass, 2 no itinerary, 1 could not run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const need = (name) => args.get(name) ?? (console.error(`otp-smoke: ${name} is required`), process.exit(1));
const base = need('--base').replace(/\/$/, '');
const sources = JSON.parse(readFileSync(need('--sources'), 'utf8'));
const lastServiceDate = need('--last-service-date');
const zone = sources.timezone;
const startedAtEpochMilliseconds = Number(args.get('--started-at-epoch-ms') ?? Date.now());
if (!Number.isFinite(startedAtEpochMilliseconds) || startedAtEpochMilliseconds <= 0) {
  console.error('otp-smoke: --started-at-epoch-ms must be a positive number');
  process.exit(1);
}

const todayIn = () => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const today = args.get('--today') ?? todayIn();
const addDays = (isoDay, n) => new Date(Date.parse(`${isoDay}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const tomorrow = addDays(today, 1);
const day = tomorrow <= lastServiceDate ? tomorrow : today;

// the UTC offset of `zone` at the given local date and time, e.g. +02:00
function offsetAt(isoDay, localTime) {
  const instant = new Date(`${isoDay}T${localTime}:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(instant).find((p) => p.type === 'timeZoneName').value;
  const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return match === null ? '+00:00' : `${match[1]}:${match[2] ?? '00'}`;
}
const smokeQueries = sources.smokes ?? (sources.smoke === undefined ? [] : [sources.smoke]);
if (!Array.isArray(smokeQueries) || smokeQueries.length === 0) {
  console.error('otp-smoke: sources must configure smoke or smokes');
  process.exit(1);
}

async function waitForHealth(timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    try {
      const response = await fetch(`${base}/otp/actuators/health`);
      if (response.status === 200) return Date.now() - startedAtEpochMilliseconds;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`OTP did not become healthy within ${timeoutSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

const QUERY = `query Plan($origin: PlanLabeledLocationInput!, $destination: PlanLabeledLocationInput!, $dateTime: PlanDateTimeInput, $first: Int) {
  planConnection(origin: $origin, destination: $destination, dateTime: $dateTime, first: $first) {
    searchDateTime
    pageInfo { searchWindowUsed }
    routingErrors { code description inputField }
    edges { node { start end legs { mode duration from { name } to { name } } } }
  }
}`;
const place = (p) => ({ label: p.label, location: { coordinate: { latitude: p.latitude, longitude: p.longitude } } });
const diagnosticsDirectory = args.get('--diagnostics-dir');
if (diagnosticsDirectory !== undefined) mkdirSync(diagnosticsDirectory, { recursive: true });
const safeName = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);

try {
  const startupMilliseconds = await waitForHealth(600);
  const checks = [];
  let protocolFailure = false;
  for (const [index, smoke] of smokeQueries.entries()) {
    const earliestDeparture = `${day}T${smoke.localTime}:00${offsetAt(day, smoke.localTime)}`;
    const variables = { origin: place(smoke.origin), destination: place(smoke.destination), dateTime: { earliestDeparture }, first: 10 };
    const requestBody = { query: QUERY, variables };
    const requestedAt = performance.now();
    const response = await fetch(`${base}/otp/gtfs/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const responseText = await response.text();
    let body;
    try { body = JSON.parse(responseText); } catch { body = { parseError: 'Response is not JSON', rawText: responseText }; }
    const responseMilliseconds = Math.round((performance.now() - requestedAt) * 100) / 100;
    const diagnosticName = `${String(index + 1).padStart(2, '0')}-${safeName(smoke.name ?? `${smoke.origin.label}-to-${smoke.destination.label}`)}`;
    if (diagnosticsDirectory !== undefined) {
      writeFileSync(join(diagnosticsDirectory, `${diagnosticName}.request.json`), `${JSON.stringify(requestBody, null, 2)}\n`);
      writeFileSync(join(diagnosticsDirectory, `${diagnosticName}.response.json`), `${JSON.stringify({ httpStatus: response.status, body }, null, 2)}\n`);
    }
    const apiErrors = body.errors ?? (body.parseError === undefined ? [] : [{ message: body.parseError }]);
    if (!response.ok || apiErrors.length > 0) protocolFailure = true;
    const itineraries = (body.data?.planConnection?.edges ?? []).map((edge) => ({
      start: edge.node.start,
      end: edge.node.end,
      legs: edge.node.legs.map((leg) => ({ mode: leg.mode, seconds: leg.duration, from: leg.from.name, to: leg.to.name })),
    }));
    const withTransit = itineraries.filter((it) => it.legs.some((leg) => !['WALK', 'BICYCLE', 'CAR'].includes(leg.mode)));
    checks.push({
      query: { origin: smoke.origin.label, destination: smoke.destination.label, earliestDeparture },
      responseMilliseconds,
      httpStatus: response.status,
      graphqlErrors: apiErrors,
      routingErrors: body.data?.planConnection?.routingErrors ?? [],
      searchDateTime: body.data?.planConnection?.searchDateTime ?? null,
      searchWindowUsed: body.data?.planConnection?.pageInfo?.searchWindowUsed ?? null,
      itineraryCount: itineraries.length,
      itinerariesWithTransit: withTransit.length,
      itineraries,
      verdict: response.ok && apiErrors.length === 0 && withTransit.length > 0 ? 'PASS' : 'FAIL',
    });
  }
  const itineraryCount = checks.reduce((sum, check) => sum + check.itineraryCount, 0);
  const itinerariesWithTransit = checks.reduce((sum, check) => sum + check.itinerariesWithTransit, 0);
  const result = {
    schema: 'otp-smoke-result-v2',
    territory: sources.territory,
    feedLastServiceDate: lastServiceDate,
    startupMilliseconds,
    responseMilliseconds: checks.map((check) => check.responseMilliseconds),
    itineraryCount,
    itinerariesWithTransit,
    checks,
    verdict: checks.every((check) => check.verdict === 'PASS') ? 'PASS' : 'FAIL',
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (args.get('--out') !== undefined) writeFileSync(args.get('--out'), text);
  process.stdout.write(text);
  process.exitCode = protocolFailure ? 1 : result.verdict === 'PASS' ? 0 : 2;
} catch (error) {
  console.error(`otp-smoke: ${error.message}`);
  if (args.get('--out') !== undefined) {
    writeFileSync(args.get('--out'), `${JSON.stringify({
      schema: 'otp-smoke-result-v2',
      territory: sources.territory,
      feedLastServiceDate: lastServiceDate,
      verdict: 'ERROR',
      fatalError: error.message,
    }, null, 2)}\n`);
  }
  process.exitCode = 1;
}
