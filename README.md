# OTP graph build (GitHub Actions)

A standalone pipeline that builds an [OpenTripPlanner](https://www.opentripplanner.org/) 2.9.0 graph from **public, redistributable
inputs** on a free GitHub-hosted runner, and publishes it as a workflow artifact. It contains no application code, no secret and no
paid service. See `NOTICE.md` for the data licences.

## What a run does
1. Validates its inputs and the runner (≥ ~14.5 GB RAM, ≥ 10 GB free disk).
2. Downloads the OTP jar from Maven Central and checks its pinned SHA-256.
3. Downloads the OpenStreetMap extract (Geofabrik, dated, immutable) and checks size, pinned SHA-256 and the publisher's MD5.
4. Downloads the GTFS feed, checks the archive, **pins it to a SHA-256** (input `expected_gtfs_sha256`) and runs the **temporal
   validity gate** (`scripts/check-gtfs-validity.mjs`): there must be service today and at least `min_future_days` after it, and
   optionally until `gtfs_must_cover_until`. An expired or too-short feed stops the run before any build.
5. Builds the graph inside the Temurin image pinned by digest (`versions.json`), with a heap of `heap_gb` (default 12 of 16 GB).
6. Loads the graph and asks it for real itineraries (`scripts/otp-smoke.mjs`); the run fails if none with transit comes back.
7. Compresses the graph (zstd), writes `manifest.json` (inputs, hashes, software, `usableUntil`) and uploads everything, with
   `NOTICE.md`, as the artifact `otp-graph-<territory>-<run id>`.

## Start it
Actions → *Build OTP graph* → *Run workflow*. Only manual starts exist (`workflow_dispatch`). Job limit: 150 minutes (GitHub's
maximum is 6 hours); the build step is capped at 100 minutes.

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
- The GTFS feed is mutable: a run is reproducible only with `expected_gtfs_sha256` set.
- Artifact storage quotas for public repositories are not stated in GitHub's billing pages; the graph is shipped compressed and with a
  short default retention (7 days).
- Publishing the artifact publicly distributes an ODbL-derived database: keep `NOTICE.md` with it.
- No licence file is included yet: choose one for the pipeline code before making the repository public.
