#!/usr/bin/env bash
# AUTO-02: installs a qualified, published OTP graph on the routing host, verifies it for real and puts the previous graph
# back if anything fails. It is the procedure used by hand for run 44552853834, made reusable. The host pulls: no secret,
# no inbound access, nothing in GitHub can reach it.
#
#   helekh-graph-deploy.sh check      report what would be installed; changes nothing (default)
#   helekh-graph-deploy.sh apply      install it; needs DEPLOY_ENABLED=true in the configuration
#   helekh-graph-deploy.sh rollback   put the previous graph back; needs DEPLOY_ENABLED=true
#   helekh-graph-deploy.sh adopt MANIFEST   record the manifest of the graph already active (once, at installation)
#
# Exit: 0 done or nothing to do; 1 refused before touching the service; 2 failed and the previous graph is serving again;
#       3 failed and the service needs a person.
set -Euo pipefail
umask 022

CONFIG=${HELEKH_DEPLOY_CONFIG:-/etc/helekh/graph-deploy.env}
# shellcheck disable=SC1090
[[ -f "$CONFIG" ]] && source "$CONFIG"

DEPLOY_ENABLED=${DEPLOY_ENABLED:-false}
REPOSITORY=${REPOSITORY:-Moov3nt/helekh-otp-graph-build}
TERRITORY=${TERRITORY:-milano-test}
TIMEZONE=${TIMEZONE:-Europe/Rome}
ACTIVE_GRAPH=${ACTIVE_GRAPH:-/home/opc/graph.obj}
STATE_DIR=${STATE_DIR:-/home/opc/graph-deploy}
OTP_CONTAINER=${OTP_CONTAINER:-helekh-otp}
JOURNEY_CONTAINER=${JOURNEY_CONTAINER:-helekh-journey}
GRAPH_IN_CONTAINER=${GRAPH_IN_CONTAINER:-/var/opentripplanner/graph.obj}
OTP_URL=${OTP_URL:-http://127.0.0.1:8080}
JOURNEY_URL=${JOURNEY_URL:-http://127.0.0.1:3000}
GITHUB_API=${GITHUB_API:-https://api.github.com}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-600}
HEALTH_INTERVAL=${HEALTH_INTERVAL:-5}
GRAPH_OWNER=${GRAPH_OWNER:-opc:opc}
ORIGIN_JSON=${ORIGIN_JSON:-'{"label":"Milano Centrale","latitude":45.4865,"longitude":9.2051}'}
DESTINATION_JSON=${DESTINATION_JSON:-'{"label":"San Siro","latitude":45.4781,"longitude":9.124}'}
DOCKER=${DOCKER:-docker}
CURL=${CURL:-curl}
ZSTD_DECOMPRESS=${ZSTD_DECOMPRESS:-zstd -d --long=27 -q -c}
TODAY=${TODAY:-}

ACTIVE_MANIFEST="$STATE_DIR/active-manifest.json"
PREVIOUS="$STATE_DIR/previous"
MARKER="$STATE_DIR/in-progress"
QUARANTINE="$STATE_DIR/quarantine"
BACKUPS="$STATE_DIR/backups"
STAGING="$STATE_DIR/staging"
LOCK="$STATE_DIR/lock"
NEXT="$(dirname "$ACTIVE_GRAPH")/.graph.obj.next"

log() { local line; line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; echo "$line"; echo "$line" >> "$STATE_DIR/deploy.log"; }
refuse() { log "DEPLOY REFUSED: $*"; exit 1; }
hash_of() { sha256sum "$1" | awk '{print $1}'; }
fetch() { "$CURL" -fsSL --retry 3 --max-time 1800 -o "$2" "$1"; }
# every piece of JSON and date logic runs on the Node already present in the Journey Service container
js() { "$DOCKER" exec -i "$JOURNEY_CONTAINER" node -e "$1" -- "${@:2}"; }
inspect() { "$DOCKER" inspect "$1" --format "$2"; }
field() { js 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(d));if(v===undefined||v===null)process.exit(1);console.log(v)})' "$1" < "$2"; }
today() { if [[ -n "$TODAY" ]]; then echo "$TODAY"; else js 'console.log(new Intl.DateTimeFormat("en-CA",{timeZone:process.argv[1],year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()))' "$TIMEZONE" < /dev/null; fi; }
# the day to test on: tomorrow if the graph covers it, else today if it does, else none
check_day() {
  js 'const [t,u]=process.argv.slice(1);const n=new Date(Date.parse(t+"T00:00:00Z")+86400000).toISOString().slice(0,10);console.log(n<=u?n:(t<=u?t:"none"))' "$(today)" "$1" < /dev/null
}

wait_for_otp() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  until "$CURL" -fsS --max-time 10 "$OTP_URL/otp/actuators/health" > /dev/null 2>&1; do
    (( SECONDS < deadline )) || return 1
    sleep "$HEALTH_INTERVAL"
  done
}

container_hash_is() {
  local actual
  actual=$("$DOCKER" exec "$OTP_CONTAINER" sha256sum "$GRAPH_IN_CONTAINER" | awk '{print $1}') || return 1
  log "container_graph_sha256=$actual"
  [[ "$actual" == "$1" ]]
}

otp_route() {
  js '
const [base,day,zone,origin,destination]=process.argv.slice(1);
const place=p=>{const v=JSON.parse(p);return {label:v.label,location:{coordinate:{latitude:v.latitude,longitude:v.longitude}}}};
const offset=new Intl.DateTimeFormat("en-US",{timeZone:zone,timeZoneName:"longOffset"}).formatToParts(new Date(day+"T19:00:00Z")).find(p=>p.type==="timeZoneName").value.replace("GMT","")||"+00:00";
const query="query Plan($origin: PlanLabeledLocationInput!, $destination: PlanLabeledLocationInput!, $dateTime: PlanDateTimeInput, $first: Int) { planConnection(origin: $origin, destination: $destination, dateTime: $dateTime, first: $first) { edges { node { legs { mode } } } } }";
(async()=>{const r=await fetch(base+"/otp/gtfs/v1",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query,variables:{origin:place(origin),destination:place(destination),dateTime:{earliestDeparture:day+"T19:00:00"+offset},first:10}}),signal:AbortSignal.timeout(60000)});
const b=await r.json();const all=(b.data?.planConnection?.edges??[]).map(e=>e.node);
const transit=all.filter(i=>i.legs.some(l=>!["WALK","BICYCLE","CAR"].includes(l.mode)));
console.log(JSON.stringify({check:"otp",day,status:r.status,itineraries:all.length,withTransit:transit.length}));
if(!r.ok||b.errors||transit.length<1)process.exit(2)})().catch(e=>{console.error(e.message);process.exit(1)})' \
    "$OTP_URL" "$1" "$TIMEZONE" "$ORIGIN_JSON" "$DESTINATION_JSON" < /dev/null
}

journey_route() {
  js '
const [base,day,zone,origin,destination]=process.argv.slice(1);
const o=JSON.parse(origin),d=JSON.parse(destination);
const offset=new Intl.DateTimeFormat("en-US",{timeZone:zone,timeZoneName:"longOffset"}).formatToParts(new Date(day+"T20:00:00Z")).find(p=>p.type==="timeZoneName").value.replace("GMT","")||"+00:00";
const place=p=>({label:p.label,latitude:p.latitude,longitude:p.longitude,provenance:"USER_RESOLVED",originalText:p.label});
const post=(path,body,headers={})=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
(async()=>{const health=await fetch(base+"/health",{signal:AbortSignal.timeout(10000)});if(!health.ok)throw new Error("Journey health "+health.status);
const session=await post("/journey-intelligence/session",{installationId:require("node:crypto").randomBytes(16).toString("hex")});
const s=await session.json();if(!session.ok||typeof s.token!=="string")throw new Error("Journey session "+session.status);
const r=await post("/journey-intelligence/outbound-alternatives",{direction:"Outbound",originText:o.label,destinationVenueLabel:d.label,arriveByIso:day+"T20:00:00"+offset,originPlace:place(o),eventPlace:place(d)},{authorization:"Bearer "+s.token});
const b=await r.json();const all=Array.isArray(b.alternatives)?b.alternatives:[];
const transit=all.filter(a=>(a.legs??[]).some(l=>["Bus","Metro","Rail"].includes(l.mode)));
console.log(JSON.stringify({check:"journey",day,status:r.status,contractVersion:b.contractVersion,alternatives:all.length,withTransit:transit.length}));
if(!r.ok||transit.length<1)process.exit(2)})().catch(e=>{console.error(e.message);process.exit(1)})' \
    "$JOURNEY_URL" "$1" "$TIMEZONE" "$ORIGIN_JSON" "$DESTINATION_JSON" < /dev/null
}

# health, loaded graph identity and, on a day the graph covers, real routes through OTP and through the Journey Service
verify_serving() {
  local sha=$1 until_date=$2 reload=${3:-} day
  wait_for_otp || { log "verify: OTP did not become healthy"; return 1; }
  container_hash_is "$sha" || { log "verify: the container does not serve the expected graph"; return 1; }
  if [[ -n "$reload" && -n "$JOURNEY_MANIFEST" ]]; then
    # the service reads the manifest when it starts
    { "$DOCKER" restart --time 30 "$JOURNEY_CONTAINER" > /dev/null && wait_for_journey; } ||
      { log "verify: the Journey Service did not come back"; return 1; }
    log "journey_service_restarted to read the manifest of $sha"
  fi
  day=$(check_day "$until_date") || return 1
  if [[ "$day" == none ]]; then log "verify: DEGRADED the graph covers no date from today on; transit routes not checked"; return 0; fi
  otp_route "$day" | tee -a "$STATE_DIR/deploy.log" || { log "verify: OTP routing failed"; return 1; }
  journey_route "$day" | tee -a "$STATE_DIR/deploy.log" || { log "verify: Journey routing failed"; return 1; }
}

# without a manifest the Journey Service must not restart at all; with one, this script restarts it and nothing else may
journey_identity() {
  if [[ -n "$JOURNEY_MANIFEST" ]]; then inspect "$JOURNEY_CONTAINER" '{{.Id}} {{.RestartCount}}'
  else inspect "$JOURNEY_CONTAINER" '{{.Id}} {{.State.StartedAt}} {{.RestartCount}}'; fi
}

# puts one file in place of the active graph while OTP is stopped; the bind mount is resolved again at start
activate() {
  local file=$1 sha=$2 until_date=$3 manifest=$4
  "$DOCKER" stop --time 30 "$OTP_CONTAINER" > /dev/null &&
    chmod 644 "$file" &&
    { [[ "$(id -u)" != 0 ]] || chown "$GRAPH_OWNER" "$file"; } &&
    mv -f "$file" "$ACTIVE_GRAPH" &&
    { [[ -z "$JOURNEY_MANIFEST" ]] || write_journey_manifest "$manifest"; } &&
    "$DOCKER" start "$OTP_CONTAINER" > /dev/null &&
    verify_serving "$sha" "$until_date" reload
}

# restores the graph named by the marker; keeps the marker unless the restore is proven
restore() {
  local old_sha old_until copy
  read -r old_sha old_until _ < "$MARKER" || return 1
  copy="$(dirname "$ACTIVE_GRAPH")/.graph.obj.rollback"
  log "ROLLBACK started restoring=$old_sha"
  local journey_copy="$BACKUPS/graph-$old_sha.journey.json"
  [[ -f "$journey_copy" ]] || journey_copy="$BACKUPS/graph-$old_sha.json"
  cp "$BACKUPS/graph-$old_sha.obj" "$copy" && [[ "$(hash_of "$copy")" == "$old_sha" ]] &&
    activate "$copy" "$old_sha" "$old_until" "$journey_copy" &&
    cp "$BACKUPS/graph-$old_sha.json" "$ACTIVE_MANIFEST.tmp" && mv -f "$ACTIVE_MANIFEST.tmp" "$ACTIVE_MANIFEST" &&
    rm -f "$MARKER" && log "ROLLBACK PASS restored=$old_sha" && return 0
  log "ROLLBACK INCOMPLETE manual recovery required; backup $BACKUPS/graph-$old_sha.obj"
  return 1
}

preflight() {
  local tool
  for tool in sha256sum "${ZSTD_DECOMPRESS%% *}" "$CURL" "$DOCKER"; do
    command -v "$tool" > /dev/null || refuse "$tool is missing"
  done
  [[ -f "$ACTIVE_GRAPH" ]] || refuse "no active graph at $ACTIVE_GRAPH"
  [[ "$(inspect "$OTP_CONTAINER" '{{.State.Status}}')" == running ]] || [[ -f "$MARKER" ]] || refuse "$OTP_CONTAINER is not running"
  [[ "$(inspect "$JOURNEY_CONTAINER" '{{.State.Status}}')" == running ]] || refuse "$JOURNEY_CONTAINER is not running"
  find_journey_manifest
}

# JI-02: when the Journey Service is configured to read the manifest of the active graph, find that file on the host. Only
# this one variable is read; no other value of the container's environment is kept or logged.
find_journey_manifest() {
  local inside destination source best=""
  JOURNEY_MANIFEST=""
  inside=$(inspect "$JOURNEY_CONTAINER" '{{range .Config.Env}}{{println .}}{{end}}' |
    sed -n 's/^JOURNEY_SERVICE_OTP_GRAPH_MANIFEST_PATH=//p') || refuse "cannot inspect $JOURNEY_CONTAINER"
  [[ -n "$inside" ]] || return 0
  while IFS='|' read -r destination source; do
    [[ -n "$destination" ]] || continue
    if [[ "$inside" == "$destination" || "$inside" == "${destination%/}/"* ]] && (( ${#destination} > ${#best} )); then
      best=$destination
      JOURNEY_MANIFEST="$source${inside#"$destination"}"
    fi
  done < <(inspect "$JOURNEY_CONTAINER" '{{range .Mounts}}{{.Destination}}|{{.Source}}{{println}}{{end}}')
  [[ -n "$JOURNEY_MANIFEST" && -f "$JOURNEY_MANIFEST" ]] || refuse "the Journey Service reads a graph manifest that cannot be located on the host"
}

require_coherent_journey_manifest() {
  [[ -n "$JOURNEY_MANIFEST" ]] || return 0
  [[ "$(field graph.sha256 "$JOURNEY_MANIFEST")" == "$ACTIVE_SHA" ]] ||
    refuse "the manifest read by the Journey Service does not describe the active graph"
  log "journey_manifest coherent with the active graph"
}

# replaces the content the Journey Service reads, keeping owner and permissions of the file
write_journey_manifest() {
  local temporary="$JOURNEY_MANIFEST.next"
  cp "$1" "$temporary" && chmod --reference="$JOURNEY_MANIFEST" "$temporary" &&
    { [[ "$(id -u)" != 0 ]] || chown --reference="$JOURNEY_MANIFEST" "$temporary"; } &&
    mv -f "$temporary" "$JOURNEY_MANIFEST"
}

wait_for_journey() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  until "$CURL" -fsS --max-time 10 "$JOURNEY_URL/health" > /dev/null 2>&1; do
    (( SECONDS < deadline )) || return 1
    sleep "$HEALTH_INTERVAL"
  done
}

require_known_active() {
  [[ -f "$ACTIVE_MANIFEST" ]] || refuse "unknown active graph: run 'adopt <manifest.json>' once"
  ACTIVE_SHA=$(field graph.sha256 "$ACTIVE_MANIFEST") || refuse "active manifest has no graph hash"
  ACTIVE_UNTIL=$(field usableUntil "$ACTIVE_MANIFEST") || refuse "active manifest has no usableUntil"
  [[ "$(hash_of "$ACTIVE_GRAPH")" == "$ACTIVE_SHA" ]] || refuse "the active graph differs from its recorded manifest"
}

# prints "tag manifest-url graph-url" for each published graph release, newest first
published_releases() {
  js 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const prefix="otp-graph-"+process.argv[1]+"-";
JSON.parse(d).filter(r=>!r.draft&&!r.prerelease&&r.tag_name.startsWith(prefix)&&/^[0-9a-f]{64}$/.test(r.tag_name.slice(prefix.length)))
.sort((a,b)=>b.published_at.localeCompare(a.published_at)).slice(0,5).forEach(r=>{const url=n=>r.assets.find(a=>a.name===n)?.browser_download_url;
if(url("manifest.json")&&url("graph.obj.zst"))console.log([r.tag_name,url("manifest.json"),url("graph.obj.zst")].join(" "))})})' "$TERRITORY" < "$1"
}

# prints "ok runId usableUntil graphSha bytes zstSha zstBytes builtAt" or "no <reason>"
judge() {
  js 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const [tag,territory,activeSha,activeUntil,today]=process.argv.slice(1);const m=JSON.parse(d);
const hex=v=>/^[0-9a-f]{64}$/.test(v??"");const no=r=>console.log("no "+r);
if(m.schema!=="otp-graph-manifest-v2"||m.territory!==territory||tag!=="otp-graph-"+territory+"-"+m.buildFingerprint)return no("identity");
if(m.routingCheck?.verdict!=="PASS"||!(m.routingCheck?.itinerariesWithTransit>0)||m.gtfsValidity?.verdict!=="PASS")return no("not-qualified");
if(!hex(m.graph?.sha256)||!hex(m.graph?.compressed?.sha256)||!(m.graph.bytes>0)||!(m.graph.compressed.bytes>0)||!/^[1-9][0-9]*$/.test(String(m.workflow?.runId)))return no("incomplete");
if(m.graph.sha256===activeSha)return no("already-active");
if(!/^\d{4}-\d{2}-\d{2}$/.test(m.gtfsValidity.firstServiceDate??"")||m.gtfsValidity.lastServiceDate!==m.usableUntil||!hex(m.inputs?.gtfs?.sha256))return no("manifest-unusable-by-journey");
if(!/^\d{4}-\d{2}-\d{2}$/.test(m.usableUntil??"")||m.usableUntil<=today)return no("does-not-cover-tomorrow");
if(m.usableUntil<activeUntil)return no("covers-less-than-active");
console.log(["ok",m.workflow.runId,m.usableUntil,m.graph.sha256,m.graph.bytes,m.graph.compressed.sha256,m.graph.compressed.bytes,m.builtAtUtc].join(" "))})' "$@"
}

run_is_trusted() {
  fetch "$GITHUB_API/repos/$REPOSITORY/actions/runs/$1" "$STAGING/run.json" || return 1
  js 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);const ok=r.conclusion==="success"&&r.head_branch==="main"&&r.repository?.full_name===process.argv[1]&&
[".github/workflows/build-graph.yml",".github/workflows/orchestrate-graph-build.yml"].includes(r.path);process.exit(ok?0:1)})' "$REPOSITORY" < "$STAGING/run.json"
}

select_candidate() {
  local tag manifest_url graph_url verdict best_key="" now
  now=$(today)
  CANDIDATE_TAG=""
  fetch "$GITHUB_API/repos/$REPOSITORY/releases?per_page=30" "$STAGING/releases.json" || refuse "cannot list releases"
  published_releases "$STAGING/releases.json" > "$STAGING/releases.txt" || refuse "cannot read releases"
  while read -r tag manifest_url graph_url; do
    fetch "$manifest_url" "$STAGING/$tag.json" || { log "skip $tag: manifest unavailable"; continue; }
    verdict=$(judge "$tag" "$TERRITORY" "$ACTIVE_SHA" "$ACTIVE_UNTIL" "$now" < "$STAGING/$tag.json") || { log "skip $tag: unreadable manifest"; continue; }
    read -r ok run until_date graph_sha graph_bytes zst_sha zst_bytes built <<< "$verdict"
    if [[ "$ok" != ok ]]; then log "skip $tag: $run"; continue; fi
    if grep -qx "$graph_sha" "$QUARANTINE" 2> /dev/null; then log "skip $tag: quarantined after a failed deployment"; continue; fi
    run_is_trusted "$run" || { log "skip $tag: build run $run is not a successful main build"; continue; }
    if [[ "$until_date $built" > "$best_key" ]]; then
      best_key="$until_date $built"
      CANDIDATE_TAG=$tag; CANDIDATE_URL=$graph_url; CANDIDATE_UNTIL=$until_date; CANDIDATE_SHA=$graph_sha
      CANDIDATE_BYTES=$graph_bytes; CANDIDATE_ZST_SHA=$zst_sha; CANDIDATE_ZST_BYTES=$zst_bytes
    fi
  done < "$STAGING/releases.txt"
}

stage_candidate() {
  local free_kb need_kb
  need_kb=$(( (CANDIDATE_BYTES * 2 + CANDIDATE_ZST_BYTES + $(stat -c %s "$ACTIVE_GRAPH")) / 1024 ))
  free_kb=$(df -Pk "$STATE_DIR" | awk 'NR==2 {print $4}')
  (( free_kb > need_kb )) || refuse "not enough disk space (${free_kb} KiB free, ${need_kb} KiB needed)"
  fetch "$CANDIDATE_URL" "$STAGING/graph.obj.zst" || refuse "graph download failed"
  [[ "$(stat -c %s "$STAGING/graph.obj.zst")" == "$CANDIDATE_ZST_BYTES" && "$(hash_of "$STAGING/graph.obj.zst")" == "$CANDIDATE_ZST_SHA" ]] ||
    refuse "downloaded graph differs from the manifest"
  $ZSTD_DECOMPRESS "$STAGING/graph.obj.zst" > "$NEXT" || refuse "decompression failed"
  [[ "$(stat -c %s "$NEXT")" == "$CANDIDATE_BYTES" && "$(hash_of "$NEXT")" == "$CANDIDATE_SHA" ]] || refuse "decompressed graph differs from the manifest"
}

backup_active() {
  mkdir -p "$BACKUPS"
  if [[ ! -f "$BACKUPS/graph-$ACTIVE_SHA.obj" ]]; then
    cp --preserve=mode,timestamps "$ACTIVE_GRAPH" "$BACKUPS/graph-$ACTIVE_SHA.obj.part" &&
      mv "$BACKUPS/graph-$ACTIVE_SHA.obj.part" "$BACKUPS/graph-$ACTIVE_SHA.obj" || refuse "backup failed"
  fi
  [[ "$(hash_of "$BACKUPS/graph-$ACTIVE_SHA.obj")" == "$ACTIVE_SHA" ]] || refuse "backup differs from the active graph"
  cp "$ACTIVE_MANIFEST" "$BACKUPS/graph-$ACTIVE_SHA.json" || refuse "manifest backup failed"
  rm -f "$BACKUPS/graph-$ACTIVE_SHA.journey.json"
  if [[ -n "$JOURNEY_MANIFEST" ]]; then
    cp "$JOURNEY_MANIFEST" "$BACKUPS/graph-$ACTIVE_SHA.journey.json" || refuse "Journey manifest backup failed"
  fi
}

# switches from the active graph to $1 (staged file), restoring on any failure
switch_to() {
  local file=$1 sha=$2 until_date=$3 manifest=$4 before started finished
  backup_active
  before=$(journey_identity) || refuse "cannot read the Journey Service container"
  log "baseline check of the active graph"
  verify_serving "$ACTIVE_SHA" "$ACTIVE_UNTIL" || refuse "the service is not healthy before the change; nothing was touched"
  echo "$ACTIVE_SHA $ACTIVE_UNTIL $sha" > "$MARKER"
  trap 'log "interrupted"; restore && exit 2 || exit 3' INT TERM HUP
  started=$(date +%s)
  log "interruption_started target=$sha"
  if activate "$file" "$sha" "$until_date" "$manifest" && [[ "$(journey_identity)" == "$before" ]] &&
    cp "$manifest" "$ACTIVE_MANIFEST.tmp" && mv -f "$ACTIVE_MANIFEST.tmp" "$ACTIVE_MANIFEST"; then
    finished=$(date +%s)
    echo "$ACTIVE_SHA" > "$PREVIOUS"
    rm -f "$MARKER"
    trap - INT TERM HUP
    log "DEPLOY PASS active=$sha previous=$ACTIVE_SHA usableUntil=$until_date seconds=$((finished - started))"
    return 0
  fi
  log "DEPLOY FAILED target=$sha"
  echo "$sha" >> "$QUARANTINE"
  trap - INT TERM HUP
  restore && exit 2
  exit 3
}

prune() {
  local keep=("$(cat "$PREVIOUS" 2> /dev/null)" "$(field graph.sha256 "$ACTIVE_MANIFEST")") file sha
  for file in "$BACKUPS"/graph-*.obj; do
    [[ -e "$file" ]] || continue
    sha=${file##*/graph-}; sha=${sha%.obj}
    [[ " ${keep[*]} " == *" $sha "* ]] || rm -f "$file" "$BACKUPS/graph-$sha.json" "$BACKUPS/graph-$sha.journey.json"
  done
  rm -rf "$STAGING"
}

main() {
  local command=${1:-check}
  mkdir -p "$STATE_DIR" || { echo "cannot create $STATE_DIR" >&2; exit 1; }
  if ! mkdir "$LOCK" 2> /dev/null; then
    if kill -0 "$(cat "$LOCK/pid" 2> /dev/null || echo 0)" 2> /dev/null; then refuse "another run holds the lock"; fi
    rm -rf "$LOCK"; mkdir "$LOCK" || refuse "cannot take the lock"
  fi
  echo $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"; rm -f "$NEXT"' EXIT
  case "$command" in
    check | apply | rollback | adopt) ;;
    *) refuse "unknown command: $command" ;;
  esac
  if [[ "$command" == apply || "$command" == rollback ]]; then
    [[ "$DEPLOY_ENABLED" == true ]] || refuse "deployment is not enabled (DEPLOY_ENABLED=true in $CONFIG)"
  fi
  preflight
  if [[ -f "$MARKER" ]]; then
    [[ "$command" == apply || "$command" == rollback ]] || refuse "an interrupted deployment is pending; run 'apply' or 'rollback'"
    log "recovering an interrupted deployment"
    read -r _ _ interrupted < "$MARKER"
    echo "$interrupted" >> "$QUARANTINE"
    restore && exit 2
    exit 3
  fi
  if [[ "$command" == adopt ]]; then
    local manifest=${2:-}
    [[ -f "$manifest" ]] || refuse "adopt needs the manifest of the active graph"
    [[ "$(field graph.sha256 "$manifest")" == "$(hash_of "$ACTIVE_GRAPH")" ]] || refuse "that manifest does not describe the active graph"
    field usableUntil "$manifest" > /dev/null || refuse "that manifest has no usableUntil"
    ACTIVE_SHA=$(hash_of "$ACTIVE_GRAPH")
    require_coherent_journey_manifest
    cp "$manifest" "$ACTIVE_MANIFEST" && log "adopted active graph $(hash_of "$ACTIVE_GRAPH")"
    exit 0
  fi
  require_known_active
  require_coherent_journey_manifest
  mkdir -p "$STAGING"
  if [[ "$command" == rollback ]]; then
    local previous copy previous_until
    previous=$(cat "$PREVIOUS" 2> /dev/null) || refuse "no previous graph recorded"
    [[ "$previous" != "$ACTIVE_SHA" && -f "$BACKUPS/graph-$previous.obj" ]] || refuse "no previous graph to restore"
    previous_until=$(field usableUntil "$BACKUPS/graph-$previous.json") || refuse "previous manifest is unreadable"
    copy="$STAGING/rollback.obj"
    cp "$BACKUPS/graph-$previous.obj" "$copy" && [[ "$(hash_of "$copy")" == "$previous" ]] || refuse "previous backup is corrupt"
    cp "$BACKUPS/graph-$previous.json" "$STAGING/rollback.json"
    mv "$copy" "$NEXT"
    echo "$ACTIVE_SHA" >> "$QUARANTINE" # so that the timer does not install it again
    switch_to "$NEXT" "$previous" "$previous_until" "$STAGING/rollback.json"
    exit 0
  fi
  select_candidate
  if [[ -z "$CANDIDATE_TAG" ]]; then log "nothing to install (active usable until $ACTIVE_UNTIL)"; exit 0; fi
  log "candidate $CANDIDATE_TAG graph=$CANDIDATE_SHA usableUntil=$CANDIDATE_UNTIL replaces=$ACTIVE_SHA usableUntil=$ACTIVE_UNTIL"
  if [[ "$command" == check ]]; then log "check only: nothing changed"; exit 0; fi
  stage_candidate
  switch_to "$NEXT" "$CANDIDATE_SHA" "$CANDIDATE_UNTIL" "$STAGING/$CANDIDATE_TAG.json"
  prune
}

main "$@"
