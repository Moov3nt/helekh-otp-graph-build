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

## Conditional build evaluation (AUTO-01D)
Actions → *Evaluate conditional OTP graph build* → *Run workflow* evaluates `main` without building when
`authorize_build=false` (the default). Optionally set `compare_with` to an earlier ancestor commit; otherwise the first parent is used.
The run publishes `evaluation/report.json` and writes one of these decisions to the GitHub summary:

- `BUILD_REQUIRED`: a fingerprint-affecting value changed and no verified graph has that identity;
- `ALREADY_BUILT`: an integrity-checked verification record contains the same fingerprint, a credible graph manifest and a passing
  routing smoke test;
- `NO_RELEVANT_CHANGE`: only unrelated/documentation files changed, or edited metadata produces the same semantic fingerprint;
- `BLOCKED`: inputs/configuration cannot be identified consistently, or a candidate verification record is incomplete or invalid.

The automatic `push` trigger is intentionally absent. A real build can only be requested manually by setting
`authorize_build=true`; even then it runs the existing `build-graph.yml` as a reusable workflow, with the evaluated fingerprint as a
mandatory assertion. Requests are serialized per territory for the entire evaluation/build run, so two concurrent requests cannot
both pass the artifact check before the first authorized build finishes. There is no Release or deploy step.

The fingerprint is the SHA-256 of canonical JSON containing:

- territory;
- OTP version, OTP JAR SHA-256 and byte size;
- digest-pinned Java runtime image;
- approved GTFS and OSM SHA-256 and byte sizes (plus the recorded OSM MD5);
- the complete territory build config, router config and OTP config;
- heap size;
- a versioned OTP CLI build recipe and SHA-256 of the GTFS validity and routing smoke scripts.

URLs, labels, licences, timestamps, Git commits and ordinary documentation are not graph identity. The Git commit remains provenance
in the manifest but is deliberately not the fingerprint. If the actual OTP invocation changes, update the build-recipe constant in
`scripts/graph-build-decision.mjs`; script content is hashed directly.

Successful builds now publish the graph artifact as before and, only after build and smoke-test success, a small
`otp-graph-verified-<territory>-<fingerprint>` record. The record contains manifest v2, full identity, input validity and routing
results. AUTO-01D downloads that exact artifact through GitHub's digest-verifying artifact action and validates its contents; an
artifact or Release name alone is never evidence of a ready graph. It also requires a successful `main` run of an authorized workflow
and the associated, unexpired graph artifact from that same run. Authorized AUTO-01D builds default to 30-day retention, while the
existing manual build retains its prior 7-day default.

To enable post-merge automation later, add a narrowly filtered `push` trigger on `main` to the orchestrator and define the reviewed
authorization policy for its build job. Keep the fingerprint assertion, per-territory concurrency, verification-record validation and
the absence of deployment. The present implementation does not grant an automatic merge event permission to build.

## Observe-only source monitor
Actions → *Monitor mobility sources (observe only)* → *Run workflow* checks one configured territory and source without changing the
pinned input or starting a graph build. The same check runs daily at 04:17 UTC for `milano-test` GTFS. It writes the classification to
the job summary, uploads `source-candidate-report.json` for three days and maintains one persistent GitHub issue per territory/source
only while attention is required. Daily timestamps do not trigger issue updates. The observation job has read-only repository access;
only the separate notification job receives `issues: write`. There is no release, pull-request, build or deployment permission. A
territory opts in with a `monitor.json` beside its `sources.json`; only `milano-test` GTFS is configured initially. When the monitor
finds a changed, technically valid, non-expired and licence-approved feed, it also retains ZIP, report and origin metadata for three
days as `gtfs-monitor-candidate-<territory>-<source>-<run-id>-<sha256>`. Unchanged or rejected ZIPs are never duplicated.

ATM acquisition uses an explicit HTTPS allowlist and a bounded policy: 8 seconds to connect, 45 seconds maximum per attempt, at most
two attempts per enabled URL with a 2-second delay, a 145-second total budget, at most two redirects and a 60,000,000-byte body limit.
HTTP 4xx, HTTP 5xx, connection/transfer timeouts, incomplete bodies, size violations and unauthorized redirects are reported
separately. Redirects are followed only when the destination remains HTTPS on an allowlisted host. The 60 MB ceiling leaves more than
twice the headroom required by the verified 25,482,440-byte ATM snapshot; a 45-second transfer window corresponds to roughly 4.5
Mbit/s for that snapshot.

The enabled primary is the official Comune di Milano shortcut `https://dati.comune.milano.it/gtfs.zip`. The catalog resource URL is
recorded in `monitor.json` but remains disabled: on 2026-11-20 both official paths resolved to the same host/IP and timed out without a
response, so neither content identity nor operational independence could be established. It is therefore not yet a qualified fallback.
The source report retains the stable publisher provenance plus the configured/final URL and the outcome of every acquisition attempt.

## Controlled GTFS promotion
Actions → *Promote verified GTFS input* → *Run workflow* performs a new download from the configured official publisher URL; it does
not trust a previous monitor report. The read-only job repeats SHA-256, ZIP, effective-calendar, trip and approved-licence checks. An
unchanged or invalid feed stops there. A valid changed feed is reverified by a separate write-scoped job, published as deterministic
Release assets whose names and tag include the full content SHA-256, and proposed through an unmerged PR changing only the territory's
GTFS metadata. The adjacent input manifest records provenance, size, hash, licence, version and effective validity. The workflow has no
schedule and AUTO-01B never invokes it automatically; no graph build or deployment is part of promotion.

Promotion has two explicit acquisition modes. `direct` applies the same bounded, allowlisted acquisition policy as the monitor.
`monitor_artifact` requires the exact
AUTO-01B run ID, resolves only the candidate artifact produced by `.github/workflows/monitor-sources.yml` in this repository, verifies
its GitHub digest, origin manifest, territory, source, run, ZIP hash and size, then repeats the full GTFS and temporal-regression gates.
An absent, expired or discordant artifact fails without falling back to another artifact or to the publisher. Consequently, a retained
candidate can still be promoted manually while the official endpoint is temporarily unavailable.

To reuse one, take the numeric run ID from the AUTO-01B run URL or summary and dispatch *Promote verified GTFS input* with
`acquisition_mode=monitor_artifact` and that exact `monitor_run_id`. For a fresh publisher acquisition choose `direct` and leave the run
ID empty. The mode is never changed automatically after a failure.

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
