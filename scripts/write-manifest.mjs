// Writes the manifest that travels with the graph: what it was built from, with which software, and how long the feed is valid.
//   node write-manifest.mjs --out manifest.json --territory t --versions versions.json --sources sources.json
//        --osm-sha256 H --gtfs-sha256 H --gtfs-bytes N --graph-sha256 H --graph-bytes N --compressed-sha256 H --compressed-bytes N
//        --validity validity.json --smoke smoke.json --config-sha256 H --run-id ID --commit SHA --heap-gb N
import { readFileSync, writeFileSync } from 'node:fs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const need = (name) => args.get(name) ?? (console.error(`write-manifest: ${name} is required`), process.exit(1));
const json = (name) => JSON.parse(readFileSync(need(name), 'utf8'));
const versions = json('--versions');
const sources = json('--sources');
const validity = json('--validity');
const smoke = json('--smoke');

const manifest = {
  schema: 'otp-graph-manifest-v1',
  territory: need('--territory'),
  builtAtUtc: new Date().toISOString(),
  workflow: { runId: need('--run-id'), commit: need('--commit') },
  software: { otpVersion: versions.otpVersion, otpJarSha256: versions.otpJarSha256, javaImage: versions.javaImage, heapGigabytes: Number(need('--heap-gb')) },
  inputs: {
    gtfs: { name: sources.gtfs.name, url: sources.gtfs.url, sha256: need('--gtfs-sha256'), bytes: Number(need('--gtfs-bytes')), license: sources.gtfs.license, attribution: sources.gtfs.attribution },
    osm: { name: sources.osm.name, url: sources.osm.url, sha256: need('--osm-sha256'), bytes: sources.osm.bytes, license: sources.osm.license, attribution: sources.osm.attribution },
  },
  configurationSha256: need('--config-sha256'),
  gtfsValidity: { referenceDate: validity.referenceDate, ...validity.effective, verdict: validity.verdict },
  graph: { file: 'graph.obj', bytes: Number(need('--graph-bytes')), sha256: need('--graph-sha256'), compressed: { file: 'graph.obj.zst', bytes: Number(need('--compressed-bytes')), sha256: need('--compressed-sha256') } },
  routingCheck: { verdict: smoke.verdict, itineraryCount: smoke.itineraryCount, itinerariesWithTransit: smoke.itinerariesWithTransit, query: smoke.query },
  usableUntil: validity.effective.lastServiceDate,
  note: 'The graph answers transit queries only for dates inside the GTFS validity above. After usableUntil rebuild from a newer feed.',
};
writeFileSync(need('--out'), `${JSON.stringify(manifest, null, 2)}\n`);
