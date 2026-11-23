# Roma graph integration preparation assessment

This record qualifies the preserved Roma graph for routing evidence only. It does not deploy it and does not alter the failed diagnostic run or its `UNQUALIFIED` artifact.

## Current deployment evidence

- Oracle capacity documented for HELEKH: 2 OCPU and 12 GB RAM total; storage allowance is evaluated separately against 200 GB.
- The deployed Milano topology is a single `helekh-otp` container, a single `/home/opc/graph.obj` bind mount and loopback port `8080`.
- That container has an 8 GiB memory limit and 16 GiB memory+swap limit.
- Journey Service expects the single loopback OTP endpoint; no geographic graph selector is present in this assessment and none was changed.
- Milano graph size is 592,385,782 bytes uncompressed and 282,047,536 bytes compressed.
- Roma graph size is 452,823,126 bytes uncompressed and 204,888,629 bytes compressed.
- Roma used 4,097,118,208 bytes working set and 4,098,715,648 bytes peak working set during the qualifying local load.

## Capacity verdict

Storage for both active graph files is about 1.05 GB, or about 1.54 GB when the two compressed copies are retained as well. Graph storage is therefore not the limiting resource within the documented allowance, although deployment backups and container layers must still be counted operationally.

Memory is not proven safe. Two OTP containers retaining the current 8 GiB limit would expose 16 GiB of container limits on a 12 GB VM, before the Journey Service, Docker and operating system. The measured Roma working set alone is about 3.82 GiB. No measured Milano steady-state working set is preserved in the reviewed deployment evidence, so lowering both limits would be an unsupported stability assumption.

The current topology also exposes only one graph and one OTP endpoint. Hosting two cities simultaneously would require a second isolated OTP runtime and geographic selection in front of it or in Journey Service; neither exists and this task does not authorize those changes.

**Decision: NO-GO for simultaneous Milano + Roma on the current configuration.** The Roma graph itself is routing-qualified and may be preserved as an integration candidate, but the current VM/topology does not meet the combined-service criterion.

## Scope limitation

Boselli 80849 is a public-transport routing endpoint. The qualification does not establish a pedestrian route from Boselli to a validated Stadio Olimpico entrance.
