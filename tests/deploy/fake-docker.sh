#!/usr/bin/env bash
# Test stand-in for the few docker commands the deployment script uses. State lives in $FAKE_STATE. Like a real file bind
# mount, the routing container sees whatever the host path holds at the moment it is started. `exec ... node` runs the
# real Node, so every script the deployment sends into the Journey container is executed for real.
set -euo pipefail
state=$FAKE_STATE
command=$1
shift
echo "$command $1 ${2:-}" | head -c 200 >> "$state/calls.log"
echo >> "$state/calls.log"
case "$command" in
  inspect)
    name=$1 format=$3
    case "$format" in
      '{{.State.Status}}') if [[ -f "$state/$name.running" ]]; then echo running; else echo exited; fi ;;
      '{{.Id}} {{.State.StartedAt}} {{.RestartCount}}') echo "id-$name $(cat "$state/$name.started") 0" ;;
      '{{.Id}} {{.RestartCount}}') echo "id-$name 0" ;;
      *'.Config.Env'*) cat "$state/$name.env" ;;
      *'.Mounts'*) cat "$state/$name.mounts" 2> /dev/null || true ;;
      *) echo "unexpected format $format" >&2; exit 64 ;;
    esac
    ;;
  restart)
    name=${@: -1}
    touch "$state/$name.running"
    echo restarted >> "$state/$name.started"
    if [[ -f "$state/journey_manifest_path" ]]; then cp "$(cat "$state/journey_manifest_path")" "$state/journey-read.json"; fi
    ;;
  stop)
    rm -f "$state/${@: -1}.running"
    ;;
  start)
    name=$1
    [[ ! -f "$state/start_fails" ]] || exit 1
    cp "$FAKE_ACTIVE_GRAPH" "$state/loaded"
    touch "$state/$name.running"
    if [[ -f "$state/journey_restarts_with_new_graph" ]] && grep -q NEW "$state/loaded"; then echo restarted > "$state/helekh-journey.started"; fi
    ;;
  exec)
    if [[ "$1" == -i ]]; then
      shift 2 # -i container
      shift   # "node"
      exec node "$@"
    fi
    [[ -f "$state/$1.running" ]] || exit 1
    sha256sum "$state/loaded"
    ;;
  *) echo "unexpected docker command $command" >&2; exit 64 ;;
esac
