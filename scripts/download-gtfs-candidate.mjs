// Bounded, allowlisted acquisition for official GTFS sources. Redirects are followed manually and only to approved HTTPS hosts.
import { writeFileSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const wait = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));
const retryable = new Set(['TIMEOUT', 'CONNECT_TIMEOUT', 'NETWORK', 'HTTP_5XX', 'INCOMPLETE']);
const authorizedHttpsUrl = (parsed, allowedHosts) => parsed.protocol === 'https:'
  && (parsed.port === '' || parsed.port === '443')
  && parsed.username === '' && parsed.password === ''
  && allowedHosts.includes(parsed.hostname);

export function validateDownloadPolicy(policy) {
  const integer = (name, minimum, maximum) => {
    const value = policy?.[name];
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`invalid download policy ${name}`);
    return value;
  };
  const normalized = {
    maximumAttemptsPerUrl: integer('maximumAttemptsPerUrl', 1, 2),
    connectTimeoutSeconds: integer('connectTimeoutSeconds', 1, 30),
    attemptTimeoutSeconds: integer('attemptTimeoutSeconds', 10, 120),
    retryDelaySeconds: integer('retryDelaySeconds', 0, 10),
    totalBudgetSeconds: integer('totalBudgetSeconds', 10, 300),
    maximumBytes: integer('maximumBytes', 1_000_000, 100_000_000),
    maximumRedirects: integer('maximumRedirects', 0, 5),
    allowedHosts: policy.allowedHosts,
    urls: policy.urls,
  };
  if (!Array.isArray(normalized.allowedHosts) || normalized.allowedHosts.length === 0 || normalized.allowedHosts.some((host) => !/^[a-z0-9.-]+$/.test(host))) throw new Error('invalid download policy allowedHosts');
  if (!Array.isArray(normalized.urls) || normalized.urls.length === 0) throw new Error('download policy has no URLs');
  const ids = new Set();
  normalized.urls = normalized.urls.map((entry) => {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(entry?.id ?? '') || ids.has(entry.id)) throw new Error('download policy URL ID is invalid or duplicated');
    ids.add(entry.id);
    const parsed = new URL(entry.url);
    if (!authorizedHttpsUrl(parsed, normalized.allowedHosts)) throw new Error(`download policy URL ${entry.id} is not allowlisted`);
    return { id: entry.id, url: parsed.href, enabled: entry.enabled === true, qualification: entry.qualification ?? null };
  });
  if (!normalized.urls.some((entry) => entry.enabled)) throw new Error('download policy has no enabled URL');
  return normalized;
}

export function validateRedirect(currentUrl, location, allowedHosts) {
  let target;
  try { target = new URL(location, currentUrl); } catch { throw new Error('REDIRECT_INVALID'); }
  if (!authorizedHttpsUrl(target, allowedHosts)) throw new Error(`REDIRECT_UNAUTHORIZED:${target.hostname || 'unknown'}`);
  return target.href;
}

function singleHttpsRequest(url, { connectTimeoutMs, attemptTimeoutMs, maximumBytes }) {
  return new Promise((accept) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; accept(value); } };
    const request = https.get(url, { headers: { Accept: 'application/zip', 'User-Agent': 'HELEKH-GTFS-acquisition/1' } });
    const totalTimer = setTimeout(() => request.destroy(Object.assign(new Error('attempt timeout'), { code: 'TIMEOUT' })), attemptTimeoutMs);
    request.on('socket', (socket) => {
      if (!socket.connecting) return;
      const connectTimer = setTimeout(() => request.destroy(Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' })), connectTimeoutMs);
      socket.once('secureConnect', () => clearTimeout(connectTimer));
      socket.once('error', () => clearTimeout(connectTimer));
    });
    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume(); clearTimeout(totalTimer); finish({ outcome: 'REDIRECT', status, location: response.headers.location ?? null, bytes: 0 }); return;
      }
      if (status < 200 || status >= 300) {
        response.resume(); clearTimeout(totalTimer); finish({ outcome: status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX', status, bytes: 0 }); return;
      }
      const declared = response.headers['content-length'] === undefined ? null : Number(response.headers['content-length']);
      if (declared !== null && (!Number.isInteger(declared) || declared < 0 || declared > maximumBytes)) {
        response.destroy(); clearTimeout(totalTimer); finish({ outcome: 'SIZE_LIMIT', status, bytes: 0, declaredBytes: declared }); return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maximumBytes) response.destroy(Object.assign(new Error('size limit'), { code: 'SIZE_LIMIT' }));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(totalTimer);
        if (declared !== null && bytes !== declared) finish({ outcome: 'INCOMPLETE', status, bytes, declaredBytes: declared });
        else finish({ outcome: 'SUCCESS', status, bytes, buffer: Buffer.concat(chunks), declaredBytes: declared });
      });
      response.on('aborted', () => { clearTimeout(totalTimer); finish({ outcome: 'INCOMPLETE', status, bytes, declaredBytes: declared }); });
      response.on('error', (error) => { clearTimeout(totalTimer); finish({ outcome: error.code === 'SIZE_LIMIT' ? 'SIZE_LIMIT' : 'INCOMPLETE', status, bytes, declaredBytes: declared, error: error.message }); });
    });
    request.on('error', (error) => { clearTimeout(totalTimer); finish({ outcome: ['TIMEOUT', 'CONNECT_TIMEOUT'].includes(error.code) ? error.code : 'NETWORK', status: null, bytes: 0, error: error.message }); });
  });
}

export async function downloadAttempt({ url, policy, timeoutSeconds }) {
  const started = Date.now();
  let currentUrl = url;
  const redirects = [];
  for (let count = 0; count <= policy.maximumRedirects; count += 1) {
    const elapsed = Date.now() - started;
    const remainingMs = Math.max(1, timeoutSeconds * 1000 - elapsed);
    const response = await singleHttpsRequest(currentUrl, { connectTimeoutMs: policy.connectTimeoutSeconds * 1000, attemptTimeoutMs: remainingMs, maximumBytes: policy.maximumBytes });
    if (response.outcome !== 'REDIRECT') return { ...response, finalUrl: currentUrl, redirects, durationMs: Date.now() - started };
    if (!response.location) return { outcome: 'REDIRECT_INVALID', status: response.status, bytes: 0, finalUrl: currentUrl, redirects, durationMs: Date.now() - started };
    try { currentUrl = validateRedirect(currentUrl, response.location, policy.allowedHosts); }
    catch (error) { return { outcome: error.message.startsWith('REDIRECT_UNAUTHORIZED') ? 'REDIRECT_UNAUTHORIZED' : 'REDIRECT_INVALID', status: response.status, bytes: 0, finalUrl: currentUrl, redirects, error: error.message, durationMs: Date.now() - started }; }
    redirects.push(currentUrl);
  }
  return { outcome: 'REDIRECT_LIMIT', status: null, bytes: 0, finalUrl: currentUrl, redirects, durationMs: Date.now() - started };
}

export async function acquireGtfs({ policy: rawPolicy, attempt = downloadAttempt, sleep = wait, clock = { now: () => Date.now() } }) {
  const policy = validateDownloadPolicy(rawPolicy);
  const startedAtMs = clock.now();
  const deadline = startedAtMs + policy.totalBudgetSeconds * 1000;
  const attempts = [];
  for (const source of policy.urls.filter((entry) => entry.enabled)) {
    for (let number = 1; number <= policy.maximumAttemptsPerUrl; number += 1) {
      const remainingMs = deadline - clock.now();
      if (remainingMs < 1000) return { status: 'UNAVAILABLE', failure: 'BUDGET_EXHAUSTED', selected: null, attempts, elapsedMs: clock.now() - startedAtMs };
      const timeoutSeconds = Math.min(policy.attemptTimeoutSeconds, Math.max(1, Math.floor(remainingMs / 1000)));
      const result = await attempt({ url: source.url, source, attemptNumber: number, policy, timeoutSeconds });
      const record = { sourceId: source.id, url: source.url, attempt: number, timeoutSeconds, outcome: result.outcome, status: result.status ?? null, bytes: result.bytes ?? 0, finalUrl: result.finalUrl ?? source.url, redirects: result.redirects ?? [], durationMs: result.durationMs ?? null, error: result.error ?? null };
      attempts.push(record);
      if (result.outcome === 'SUCCESS') return { status: 'AVAILABLE', failure: null, selected: { sourceId: source.id, configuredUrl: source.url, finalUrl: record.finalUrl, bytes: result.bytes }, attempts, elapsedMs: clock.now() - startedAtMs, buffer: result.buffer };
      if (!retryable.has(result.outcome)) break;
      if (number < policy.maximumAttemptsPerUrl) {
        const delayMs = Math.min(policy.retryDelaySeconds * 1000, Math.max(0, deadline - clock.now()));
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  }
  const failure = deadline - clock.now() < 1000 ? 'BUDGET_EXHAUSTED' : attempts.at(-1)?.outcome ?? 'UNAVAILABLE';
  return { status: 'UNAVAILABLE', failure, selected: null, attempts, elapsedMs: clock.now() - startedAtMs };
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const need = (name) => args.get(name) ?? (() => { throw new Error(`${name} is required`); })();
  const monitor = JSON.parse(readFileSync(resolve(need('--monitor')), 'utf8'));
  const source = need('--source');
  const policy = validateDownloadPolicy(monitor[source]?.download);
  if (args.get('--validate-only') === 'true') {
    process.stdout.write(`${JSON.stringify({ valid: true, enabledUrls: policy.urls.filter((entry) => entry.enabled).map((entry) => entry.id) })}\n`);
    return;
  }
  const result = await acquireGtfs({ policy });
  const report = { schema: 'source-download-report-v1', checkedAtUtc: new Date().toISOString(), status: result.status, failure: result.failure, selected: result.selected, attempts: result.attempts, elapsedMs: result.elapsedMs };
  writeFileSync(resolve(need('--report')), `${JSON.stringify(report, null, 2)}\n`);
  if (result.status === 'AVAILABLE') writeFileSync(resolve(need('--out')), result.buffer);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = result.status === 'AVAILABLE' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`download-gtfs-candidate: ${error.message}`); process.exitCode = 1; });
}
