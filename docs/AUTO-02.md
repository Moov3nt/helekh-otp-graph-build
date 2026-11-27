# AUTO-02: from a new feed to a verified graph in service

AUTO-02 only links what AUTO-01 already does and adds the missing last step. The daily monitor, its schedule, its sources
and its checks, the promotion, the build decision, the build and its qualification are unchanged.

**State: implemented on the branch `auto-02-chain`, not merged, not activated.**

## Flow

| # | Stage | Done by | Stops when |
|---|---|---|---|
| 1 | Daily check of the publisher | `monitor-sources.yml` (unchanged) | feed unchanged, invalid, unlicensed or unavailable |
| 2 | Decide | `auto02-chain.yml`, job `gate` | there is no retained, valid, changed candidate |
| 3 | Promote | `promote-gtfs.yml` (unchanged), on the monitor's own candidate | its validation fails |
| 4 | Merge | job `promote`: one commit, only `sources.json`, only snapshot fields, fast-forward | anything else differs, or `main` moved |
| 5 | Evaluate, build, qualify | `orchestrate-graph-build.yml` and `build-graph.yml` (unchanged) | decision or routing check fails |
| 6 | Publish | job `publish`: draft, assets, then publication | bundle, fingerprint, hashes, routing or coverage do not match |
| 7 | Install | `deploy/oracle/helekh-graph-deploy.sh` on the host, by timer | any check fails; the previous graph is restored |

An unchanged feed never starts a build. The one resumed case is a promotion that this chain merged and whose graph was
never published; it is retried at the next monitor run.

## The host side

The host **pulls** public releases `otp-graph-<territory>-<fingerprint>`. No secret is stored anywhere, nothing is opened
towards the host and GitHub cannot act on it.

A release is installed only if all of these hold: manifest v2; fingerprint equal to the tag; routing check passed with
transit itineraries; originating build run successful on `main`; covers at least tomorrow and not less than the active
graph; not quarantined; downloaded and decompressed hashes and sizes equal to the manifest.

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

## Activation (each step needs authorization; none has been done)

1. Review and merge the branch into `main`. Nothing runs yet.
2. Set the repository variable `AUTO02_ENABLED` to `true`. From then on a new feed is promoted, built and published
   without a person.
3. On the host: check that `zstd` and `curl` exist (installing `zstd` is free).
4. Install the script as `/usr/local/sbin/helekh-graph-deploy.sh` (root, mode 755), the configuration as
   `/etc/helekh/graph-deploy.env` (root, mode 600, `DEPLOY_ENABLED=false`) and the two systemd units.
5. Record the graph now in service: `helekh-graph-deploy.sh adopt manifest.json`, with the manifest of build run
   44552853834.
6. Run `helekh-graph-deploy.sh check`.
7. Set `DEPLOY_ENABLED=true` and run `apply` by hand the first time, watching it.
8. Only then `systemctl enable --now helekh-graph-deploy.timer`.

To stop everything: remove `AUTO02_ENABLED`; disable the timer.

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

- The monitor keeps a candidate for three days and the chain acts when it finishes; a chain that fails before merging
  needs a manual re-run (`monitor_run_id`) within that time.
- A promotion branch left by a failed attempt, based on an older `main`, is refused and must be deleted by hand.
- If the repository forbids Actions to open pull requests, the promotion run ends as failed after creating its branch and
  release. The chain accepts that only when its validation job passed and the branch and release are exactly right.
- The timer installs at night: a graph published during the day is in service the following night unless `apply` is run
  by hand.
- If the Journey Service is configured with `JOURNEY_SERVICE_OTP_GRAPH_MANIFEST_PATH` (JI-02), the script refuses: it
  does not update that manifest or restart the service. This must be added before the two are used together.
- Failures are visible as failed workflow runs and failed systemd units. No other alert is added.
- Only `milano-test`.
