# AUTO-02: from a new feed to a verified graph in service

AUTO-02 only links what AUTO-01 already does and adds the missing last step. The daily monitor, its schedule, its sources
and its checks, the promotion, the build decision, the build and its qualification are unchanged.

**State: qualified locally (AUTO-02A). See the activation section for what has been switched on.**

## Flow

| # | Stage | Done by | Stops when |
|---|---|---|---|
| 1 | Daily check of the publisher | `monitor-sources.yml` (unchanged) | feed unchanged, invalid, unlicensed or unavailable |
| 2 | Decide | `auto02-chain.yml`, job `gate` | there is no retained, valid, changed candidate |
| 3 | Promote | `promote-gtfs.yml` (unchanged), on the monitor's own candidate | its validation fails |
| 4 | Merge | job `promote`: one commit, only `sources.json`, only snapshot fields, fast-forward | anything else differs, or `main` moved |
| 5 | Evaluate, build, qualify | `orchestrate-graph-build.yml` and `build-graph.yml` (unchanged) | decision or routing check fails |
| 6 | Publish, only with `AUTO02_PUBLICATION_APPROVED=true` | job `publish`: draft, assets, then publication | bundle, fingerprint, hashes, routing or coverage do not match |
| 7 | Install | `deploy/oracle/helekh-graph-deploy.sh` on the host, by timer | any check fails; the previous graph is restored |

An unchanged feed never starts a build.

## Automatic retries, and their bounds

- Within one run the promotion is attempted at most **3 times** after temporary failures (a failed or missing run, a
  missing release asset, a moved `main`, HTTP 429 or 5xx, a timeout). Evidence that is wrong stops at once.
- It is idempotent: a feed already on `main` is not promoted again; a complete promotion branch on the current `main` is
  merged as it is; a branch left on an older `main` is **deleted by the chain** and promoted again. Only a branch with
  exactly the promotion's single commit on `sources.json` is ever deleted; anything else is left untouched and reported.
- Across runs, the monitor retains a fresh candidate every day while `main` has not changed, so the next day retries by
  itself. A promotion merged without a finished graph is resumed. A verified build already recorded is not built again.
- After **5 failed chain runs in a row** automatic runs are blocked (and say so). A successful manual run, or a day with
  nothing to do, resets the count.

## The host side

The host **pulls** public releases `otp-graph-<territory>-<fingerprint>`. No secret is stored anywhere, nothing is opened
towards the host and GitHub cannot act on it.

A release is installed only if all of these hold: manifest v2; fingerprint equal to the tag; routing check passed with
transit itineraries; originating build run successful on `main`; covers at least tomorrow and not less than the active
graph; not quarantined; downloaded and decompressed hashes and sizes equal to the manifest.

If the Journey Service is configured with `JOURNEY_SERVICE_OTP_GRAPH_MANIFEST_PATH` (JI-02), the script locates that file
through the container's mounts, refuses unless it describes the active graph, replaces it together with the graph,
restarts the Journey Service so that it reads it, and restores both on failure. Without that variable the Journey
Service is never restarted. Nothing here sets the variable.

Sequence, as in the manual procedure of 19 November: baseline check of the running service, backup, stop of the routing
container, file replacement, start, health, hash of the graph inside the container, real OTP itinerary with transit, real
Journey request with a transit alternative, Journey container not restarted. On failure the previous graph is put back and
verified, and the failed graph is quarantined.

**Differences from the manual procedure**

- The same routing container is stopped and started; no second container is created. A file bind mount is resolved at
  start. If that did not hold, the hash check inside the container would fail and the previous graph would be restored.
- Test dates are computed (tomorrow), not fixed.
- The OTP and Journey checks require a transit leg.
- If the active graph no longer covers today, it is checked for health and identity only.

| Exit | Meaning |
|---|---|
| 0 | installed, or nothing to install |
| 1 | refused before touching the service |
| 2 | failed; the previous graph is serving again |
| 3 | failed; a person is needed. The marker `in-progress` is kept and the next `apply` retries the restore |

## Activation

| Step | What | Needs |
|---|---|---|
| 1 | Merge into `main` | done under AUTO-02A |
| 2 | Repository variable `AUTO02_ENABLED=true`: a new feed is promoted and built without a person | AUTO-02A |
| 3 | Host: install the script and units (timer **disabled**, `DEPLOY_ENABLED=false`), `adopt` the manifest of build run 44552853834, `check` | AUTO-02A |
| 4 | Repository variable `AUTO02_PUBLICATION_APPROVED=true`: qualified graphs become public releases | licence decision |
| 5 | `DEPLOY_ENABLED=true` and a first `apply` by hand, watched | authorization |
| 6 | `systemctl enable --now helekh-graph-deploy.timer` | authorization |

To stop everything: remove `AUTO02_ENABLED`; disable the timer.

## Licence of a published graph (engineering assessment, not legal advice)

- The graph combines OpenStreetMap street data (ODbL 1.0) with the Milan timetable (published as CC BY). Because the
  graph links stops to streets, it should be treated as a **derived database**, not a mere collection: the OpenStreetMap
  community guideline considers datasets independent only when they do not reference each other.
- Distributing it is therefore done under **ODbL 1.0** for the database, with the licence reference, the attributions,
  a free copy (the release itself), no technical restriction, and, for the timetable, CC BY attribution and a statement
  that it was modified. `NOTICE.md` states these.
- **Open point.** The OpenStreetMap Foundation holds that CC BY 4.0 data needs an explicit waiver before it can be added to
  OpenStreetMap. No official source found settles the same question for a third-party database combining both. The
  dataset page names "Creative Commons Attribution"; the version 4.0 comes from the portal-wide notice.
- Publication stays off until the owner decides (step 4). Until then a built graph remains a workflow artifact, as in
  AUTO-01, for 30 days.

## Verified locally

`node --test tests/*.test.mjs`. The chain is tested with a fake GitHub API. The deployment script is executed for real
against a fake docker and a local fake of OTP, Journey and the release API. The existing build decision, run on a real
commit made from what the existing promotion writes, answers `BUILD_REQUIRED`.

## Not verified

- No workflow of this branch has ever run: workflow syntax and expressions, `workflow_run`, dispatch of the existing
  workflows with the workflow token, `gh release` publication and the fast-forward of `main` are untested on GitHub.
- The script has never run on the host: docker behaviour with the bind mount, operating system tools, permissions, disk
  space, systemd units and timing.
- The real Journey answers to the new check requests.

## Limits

- Without publication approval the host has nothing to pull.
- If the repository forbids Actions to open pull requests, the promotion run ends as failed after creating its branch and
  release. The chain accepts that only when its validation job passed and the branch and release are exactly right.
- The timer installs at night: a graph published during the day is in service the following night unless `apply` is run
  by hand.
- Failures are visible as failed workflow runs and failed systemd units. No other alert is added.
- Only `milano-test`.
