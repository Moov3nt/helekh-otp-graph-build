# OTP graph build (GitHub Actions)

A standalone pipeline that builds an [OpenTripPlanner](https://www.opentripplanner.org/) 2.9.0 graph from **public, redistributable
inputs** on a free GitHub-hosted runner, and publishes it as a workflow artifact. It contains no application code, no secret and no
paid service. See `NOTICE.md` for the data licences.

## What a run does
1. Validates its inputs and the runner (≥ ~14.5 GB RAM, ≥ 10 GB free disk).
2. Downloads the OTP jar from Maven Central and checks its pinned SHA-256.
3. Downloads the verified release asset mirrored from the dated Geofabrik extract and checks size, pinned SHA-256 and the publisher MD5 recorded at acquisition.
4. Downloads the verified GTFS release asset, checks its pinned size and SHA-256, verifies the archive and runs the **temporal
   validity gate** (`scripts/check-gtfs-validity.mjs`): there must be service today and at least `min_future_days` after it, and
   optionally until `gtfs_must_cover_until`. `expected_gtfs_sha256`, when set, is an additional assertion. An expired or too-short
   feed stops the run before any build.
5. Builds the graph inside the Temurin image pinned by digest (`versions.json`), with a heap of `heap_gb` (default 12 of 16 GB).
6. Loads the graph and asks it for real itineraries (`scripts/otp-smoke.mjs`); the run fails if none with transit comes back.
7. Compresses the graph (zstd), writes `manifest.json` (inputs, hashes, software, `usableUntil`) and uploads everything, with
   `NOTICE.md`, as the artifact `otp-graph-<territory>-<run id>`.

## Start it
Actions → *Build OTP graph* → *Run workflow*. Only manual starts exist (`workflow_dispatch`). Job limit: 150 minutes (GitHub's
maximum is 6 hours); the build step is capped at 100 minutes.

## Observe-only source monitor
Actions → *Monitor mobility sources (observe only)* → *Run workflow* checks one configured territory and source without changing the
pinned input or starting a graph build. The same check runs daily at 04:17 UTC for `milano-test` GTFS. It writes the classification to
the job summary, uploads `source-candidate-report.json` for three days and maintains one persistent GitHub issue per territory/source
only while attention is required. Daily timestamps do not trigger issue updates. The observation job has read-only repository access;
only the separate notification job receives `issues: write`. There is no release, pull-request, build or deployment permission. A
territory opts in with a `monitor.json` beside its `sources.json`; only `milano-test` GTFS is configured initially.

## Controlled GTFS promotion
Actions → *Promote verified GTFS input* → *Run workflow* performs a new download from the configured official publisher URL; it does
not trust a previous monitor report. The read-only job repeats SHA-256, ZIP, effective-calendar, trip and approved-licence checks. An
unchanged or invalid feed stops there. A valid changed feed is reverified by a separate write-scoped job, published as deterministic
Release assets whose names and tag include the full content SHA-256, and proposed through an unmerged PR changing only the territory's
GTFS metadata. The adjacent input manifest records provenance, size, hash, licence, version and effective validity. The workflow has no
schedule and AUTO-01B never invokes it automatically; no graph build or deployment is part of promotion.

## Territories
A territory is a folder `territories/<name>/` with `build-config.json` and `sources.json`. `milano-test` is a **test territory**; the
pipeline itself assumes nothing about it.

## Use the artifact
```bash
zstd -d graph.obj.zst -o graph.obj          # then check graph.obj against manifest.json (graph.sha256)
```
Load it with the same OTP version (`--load`). The graph answers transit queries only until `usableUntil` in the manifest.

## Limits to know
- The runner has 16 GB RAM and 14 GB of SSD (GitHub documentation for public repositories). The graph build uses a 12 GB heap.
- Each territory must reference an immutable GTFS snapshot with pinned size and SHA-256.
- Artifact storage quotas for public repositories are not stated in GitHub's billing pages; the graph is shipped compressed and with a
  short default retention (7 days).
- Publishing the artifact publicly distributes an ODbL-derived database: keep `NOTICE.md` with it.
- No licence file is included yet: choose one for the pipeline code before making the repository public.

## Future automation boundary
- **Acquire:** periodically fetch only from the publisher URL and retain its catalog metadata and licence.
- **Validate and version:** test the ZIP, calculate size and SHA-256, run the effective-calendar gate, then publish an attributed immutable input snapshot.
- **Build conditionally:** dispatch a graph build only when a newly validated snapshot differs from the current pinned version and meets the required horizon.
- **Distribute and monitor:** promote a validated graph with an explicit rollback, while monitoring `usableUntil`, acquisition failures and build/smoke-test failures separately.

These stages are documented boundaries only; this repository does not yet schedule or deploy them automatically.
