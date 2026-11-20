// Promote one freshly validated GTFS candidate to an immutable GitHub Release asset and an unmerged PR.
// The candidate is data only: it is never executed and no value from it is interpolated into a shell command.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const identityPattern = /^[a-z0-9][a-z0-9-]{0,40}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const wait = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));

const fileSha256 = (path) => new Promise((accept, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => accept(hash.digest('hex')));
});
const bufferSha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const jsonBuffer = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function requireCandidate(report, sources, actual) {
  if (report?.schema !== 'source-candidate-report-v1') throw new Error('unsupported candidate report schema');
  if (!identityPattern.test(report.territory ?? '') || report.source !== 'gtfs') throw new Error('invalid candidate identity');
  if (sources.territory !== report.territory) throw new Error('candidate and sources territory differ');
  if (report.current?.sha256 !== sources.gtfs.sha256 || report.current?.bytes !== sources.gtfs.bytes) throw new Error('sources changed after candidate validation');
  if (report.acquisition?.publisherUrl !== sources.gtfs.publisherUrl) throw new Error('candidate provenance differs from sources policy');
  if (report.acquisition?.status !== 'AVAILABLE') throw new Error('SOURCE_UNAVAILABLE');
  if (report.license?.verdict !== 'APPROVED') throw new Error('LICENSE_NOT_APPROVED');
  if (report.integrity?.zip !== 'PASS') throw new Error('ZIP_INVALID');
  if (report.expiry?.daysRemaining < 0 || report.state === 'EXPIRED') throw new Error('GTFS_EXPIRED');
  if (report.validity?.verdict !== 'PASS') throw new Error('GTFS_INVALID');
  if (!shaPattern.test(report.candidate?.sha256 ?? '')) throw new Error('candidate SHA-256 is invalid');
  if (actual.sha256 !== report.candidate.sha256 || actual.bytes !== report.candidate.bytes) throw new Error('candidate file differs from its fresh validation report');
  const currentLastServiceDate = sources.gtfs.validUntil;
  const candidateLastServiceDate = report.validity?.effective?.lastServiceDate;
  if (!dayPattern.test(currentLastServiceDate ?? '') || !dayPattern.test(candidateLastServiceDate ?? '')) throw new Error('effective last service date is missing or invalid');
  if (candidateLastServiceDate < currentLastServiceDate) {
    throw new Error(`GTFS_TEMPORAL_REGRESSION: candidate last service date ${candidateLastServiceDate} precedes current approved ${currentLastServiceDate}`);
  }
  if (sources.gtfs.sha256 === actual.sha256 || report.candidate.change === 'UNCHANGED') return 'UNCHANGED';
  if (!['UPDATED_VALID', 'EXPIRING'].includes(report.state) || report.candidate.change !== 'UPDATED') throw new Error(`candidate is not promotable from state ${report.state}`);
  return 'UPDATED';
}

function replaceJsonObject(sourceText, property, replacement) {
  const propertyIndex = sourceText.indexOf(`"${property}"`);
  if (propertyIndex < 0) throw new Error(`sources.json has no ${property} object`);
  const open = sourceText.indexOf('{', propertyIndex);
  if (open < 0) throw new Error(`sources.json ${property} is not an object`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let close = -1;
  for (let index = open; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) { close = index; break; }
  }
  if (close < 0) throw new Error(`sources.json ${property} object is unterminated`);
  const formatted = JSON.stringify(replacement, null, 2).split('\n').map((line, index) => index === 0 ? line : `  ${line}`).join('\n');
  return `${sourceText.slice(0, open)}${formatted}${sourceText.slice(close + 1)}`;
}

export function buildPromotionPlan({ report, sources, sourcesText, repository }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('repository is invalid');
  const sha256 = report.candidate.sha256;
  const tag = `otp-inputs-gtfs-${report.territory}-${sha256}`;
  const assetName = `${report.territory}-gtfs-${sha256}.zip`;
  const manifestName = `${report.territory}-gtfs-${sha256}.manifest.json`;
  const assetUrl = `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
  const rawVersion = typeof report.feedInfo?.version === 'string' ? report.feedInfo.version.trim() : '';
  const version = /^[A-Za-z0-9._-]{1,200}$/.test(rawVersion) ? rawVersion : null;
  const updatedGtfs = {
    ...sources.gtfs,
    url: assetUrl,
    ...(version === null ? {} : { version }),
    bytes: report.candidate.bytes,
    sha256,
    validFrom: report.validity.effective.firstServiceDate,
    validUntil: report.validity.effective.lastServiceDate,
    mutable: false,
    note: 'Verified immutable snapshot acquired from the official publisher resource; promotion metadata is stored beside the Release asset.',
  };
  if (version === null) delete updatedGtfs.version;
  const updatedSourcesText = replaceJsonObject(sourcesText, 'gtfs', updatedGtfs);
  const updatedSources = JSON.parse(updatedSourcesText);
  if (JSON.stringify(updatedSources.osm) !== JSON.stringify(sources.osm)) throw new Error('OSM metadata changed unexpectedly');
  const manifest = {
    schema: 'gtfs-input-snapshot-v1',
    territory: report.territory,
    source: 'gtfs',
    acquiredAtUtc: report.checkedAtUtc,
    provenance: {
      publisherUrl: sources.gtfs.publisherUrl,
      catalogPage: sources.gtfs.catalogPage,
      publisher: sources.gtfs.publisher,
      attribution: sources.gtfs.attribution,
    },
    asset: { file: assetName, bytes: report.candidate.bytes, sha256 },
    license: { id: report.license.id, name: sources.gtfs.license, url: sources.gtfs.licenseUrl },
    validity: {
      effectiveFrom: report.validity.effective.firstServiceDate,
      effectiveUntil: report.validity.effective.lastServiceDate,
      trips: report.validity.trips,
      servicesWithTrips: report.validity.servicesWithTrips,
    },
    feedVersion: version,
  };
  const marker = `<!-- helekh-gtfs-promotion:v1 territory=${report.territory} sha256=${sha256} -->`;
  const branch = `auto/gtfs-${report.territory}-${sha256}`;
  const pullBody = [
    marker,
    '',
    'Promotes a freshly downloaded and validated GTFS snapshot. This PR does not build or deploy an OTP graph.',
    '',
    '| Field | Current | Candidate |',
    '| --- | --- | --- |',
    `| SHA-256 | \`${sources.gtfs.sha256}\` | \`${sha256}\` |`,
    `| Bytes | \`${sources.gtfs.bytes}\` | \`${report.candidate.bytes}\` |`,
    `| Effective service | \`${sources.gtfs.validFrom} through ${sources.gtfs.validUntil}\` | \`${report.validity.effective.firstServiceDate} through ${report.validity.effective.lastServiceDate}\` |`,
    `| Feed version | \`${sources.gtfs.version ?? 'unknown'}\` | \`${version ?? 'not published'}\` |`,
    '',
    `Immutable asset: ${assetUrl}`,
    '',
    'Only `territories/' + report.territory + '/sources.json` is changed; the OSM reference is preserved.',
  ].join('\n');
  return {
    sha256, tag, assetName, manifestName, assetUrl, manifest, updatedSourcesText, branch, marker,
    release: {
      tag_name: tag,
      target_commitish: 'main',
      name: `Verified GTFS ${report.territory} ${sha256}`,
      body: `Verified immutable GTFS snapshot from the configured official publisher.\n\nSHA-256: ${sha256}\nBytes: ${report.candidate.bytes}\nEffective service: ${report.validity.effective.firstServiceDate} through ${report.validity.effective.lastServiceDate}\nLicence: ${sources.gtfs.license}\nAttribution: ${sources.gtfs.attribution}`,
      draft: false,
      prerelease: false,
    },
    pull: { title: `[GTFS] Promote ${report.territory} ${sha256.slice(0, 12)}`, body: pullBody, base: 'main', head: branch },
  };
}

async function verifyAsset(api, asset, expectedBuffer, description) {
  const expectedSha = bufferSha256(expectedBuffer);
  if (asset.size !== expectedBuffer.length) throw new Error(`${description} asset name collision: size differs`);
  if (asset.digest && asset.digest !== `sha256:${expectedSha}`) throw new Error(`${description} asset name collision: digest differs`);
  if (!asset.digest) {
    const existing = await api.downloadAsset(asset.id);
    if (existing.length !== expectedBuffer.length || bufferSha256(existing) !== expectedSha) throw new Error(`${description} asset name collision: content differs`);
  }
}

function verifyExistingManifest(buffer, plan) {
  let manifest;
  try { manifest = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('manifest asset name collision: invalid JSON'); }
  if (manifest?.schema !== 'gtfs-input-snapshot-v1' || manifest.asset?.sha256 !== plan.sha256 || manifest.asset?.bytes !== plan.manifest.asset.bytes || manifest.asset?.file !== plan.assetName) {
    throw new Error('manifest asset name collision: metadata differs');
  }
}

export async function promoteCandidate({ report, sources, sourcesText, candidatePath, repository, baseSha, api }) {
  const actual = { sha256: await fileSha256(candidatePath), bytes: statSync(candidatePath).size };
  const disposition = requireCandidate(report, sources, actual);
  if (disposition === 'UNCHANGED') return { action: 'UNCHANGED', sha256: actual.sha256, releaseUrl: null, pullUrl: null };
  if (!commitPattern.test(baseSha ?? '')) throw new Error('base SHA is invalid');
  const plan = buildPromotionPlan({ report, sources, sourcesText, repository });
  plan.release.target_commitish = baseSha;
  const candidateBuffer = readFileSync(candidatePath);
  const manifestBuffer = jsonBuffer(plan.manifest);

  let release = await api.getRelease(plan.tag);
  if (release === null) release = await api.createRelease(plan.release);
  const assets = await api.listReleaseAssets(release.id);
  const candidateAsset = assets.find((asset) => asset.name === plan.assetName);
  if (candidateAsset) await verifyAsset(api, candidateAsset, candidateBuffer, 'GTFS');
  else await api.uploadAsset(release.upload_url, plan.assetName, 'application/zip', candidateBuffer);
  const manifestAsset = assets.find((asset) => asset.name === plan.manifestName);
  if (manifestAsset) verifyExistingManifest(await api.downloadAsset(manifestAsset.id), plan);
  else await api.uploadAsset(release.upload_url, plan.manifestName, 'application/json', manifestBuffer);

  const existingPull = (await api.listOpenPulls()).find((pull) => String(pull.body ?? '').includes(plan.marker));
  if (existingPull) return { action: 'REUSED_EXISTING_PR', sha256: plan.sha256, releaseUrl: release.html_url, pullUrl: existingPull.html_url };

  const existingBranch = await api.getBranch(plan.branch);
  const sourcePath = `territories/${report.territory}/sources.json`;
  if (existingBranch) {
    const existingText = await api.getFile(sourcePath, plan.branch);
    if (existingText !== plan.updatedSourcesText) throw new Error('promotion branch collision: sources.json differs');
  } else {
    await api.createBranchCommit({ branch: plan.branch, baseSha, path: sourcePath, content: plan.updatedSourcesText, message: `chore(gtfs): promote ${report.territory} ${plan.sha256}` });
  }
  const pull = await api.createPull(plan.pull);
  return { action: candidateAsset ? 'REUSED_ASSET_AND_CREATED_PR' : 'CREATED_ASSET_AND_PR', sha256: plan.sha256, releaseUrl: release.html_url, pullUrl: pull.html_url };
}

export function createPromotionGitHubApi({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch, sleep = wait, maximumAttempts = 3 } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY is invalid');
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const request = async (method, url, { body, binary = false, allow404 = false, contentType = 'application/json' } = {}) => {
    const attempts = method === 'GET' ? maximumAttempts : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method,
          headers: { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'X-GitHub-Api-Version': '2022-11-28' },
          body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
          signal: AbortSignal.timeout(30000),
        });
        if (allow404 && response.status === 404) return null;
        if (response.ok) return binary ? Buffer.from(await response.arrayBuffer()) : response.status === 204 ? null : response.json();
        const message = (await response.text()).slice(0, 300);
        const error = new Error(`GitHub API ${method} failed with HTTP ${response.status}: ${message}`);
        error.status = response.status;
        if (attempt === attempts || (response.status !== 429 && response.status < 500)) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (attempt === attempts || error.status && error.status < 500 && error.status !== 429) throw error;
      }
      await sleep(250 * (2 ** (attempt - 1)));
    }
    throw lastError;
  };
  const repoUrl = `${apiUrl}/repos/${repository}`;
  const refPath = (branch) => branch.split('/').map(encodeURIComponent).join('/');
  return {
    getRelease: (tag) => request('GET', `${repoUrl}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true }),
    createRelease: (body) => request('POST', `${repoUrl}/releases`, { body }),
    async listReleaseAssets(releaseId) {
      const output = [];
      for (let page = 1; page <= 10; page += 1) {
        const batch = await request('GET', `${repoUrl}/releases/${releaseId}/assets?per_page=100&page=${page}`);
        output.push(...batch);
        if (batch.length < 100) return output;
      }
      throw new Error('release asset scan exceeded 1000 entries');
    },
    downloadAsset: (id) => request('GET', `${repoUrl}/releases/assets/${id}`, { binary: true }),
    uploadAsset: (uploadUrl, name, contentType, body) => request('POST', `${uploadUrl.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`, { body, contentType }),
    async listOpenPulls() {
      const pulls = [];
      for (let page = 1; page <= 10; page += 1) {
        const batch = await request('GET', `${repoUrl}/pulls?state=open&per_page=100&page=${page}`);
        pulls.push(...batch);
        if (batch.length < 100) return pulls;
      }
      throw new Error('pull request scan exceeded 1000 entries');
    },
    getBranch: (branch) => request('GET', `${repoUrl}/git/ref/heads/${refPath(branch)}`, { allow404: true }),
    async getFile(path, branch) {
      const result = await request('GET', `${repoUrl}/contents/${path}?ref=${encodeURIComponent(branch)}`);
      return Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8');
    },
    async createBranchCommit({ branch, baseSha, path, content, message }) {
      const commit = await request('GET', `${repoUrl}/git/commits/${baseSha}`);
      const blob = await request('POST', `${repoUrl}/git/blobs`, { body: { content, encoding: 'utf-8' } });
      const tree = await request('POST', `${repoUrl}/git/trees`, { body: { base_tree: commit.tree.sha, tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] } });
      const created = await request('POST', `${repoUrl}/git/commits`, { body: { message, tree: tree.sha, parents: [baseSha] } });
      return request('POST', `${repoUrl}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: created.sha } });
    },
    createPull: (body) => request('POST', `${repoUrl}/pulls`, { body }),
  };
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const need = (name) => args.get(name) ?? (() => { throw new Error(`${name} is required`); })();
  const sourcesPath = resolve(need('--sources'));
  const sourcesText = readFileSync(sourcesPath, 'utf8');
  const report = JSON.parse(readFileSync(resolve(need('--report')), 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  const api = createPromotionGitHubApi({ repository, token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL });
  const result = await promoteCandidate({ report, sources: JSON.parse(sourcesText), sourcesText, candidatePath: resolve(need('--candidate')), repository, baseSha: need('--base-sha'), api });
  const out = args.get('--out');
  if (out) writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`promote-gtfs-candidate: ${error.message}`);
    process.exitCode = 1;
  });
}
