#!/bin/sh
# One step of a run, inside the sandbox. The runner execs `sh steps.sh STEP`,
# so every argument is a fixed word; the prompt comes from the run's
# read-only inputs.
#   receive   stdin -> the repository bundle, made by the runner outside
#   prepare   clone the bundle into /workspace/repo; print base= and what the sandbox observes
#   agent     run the agent in the repository, the prompt on stdin
#   freeze    kill every other process in the container; print any left that can still run
#   export    the repository's files as a POSIX tar on stdout (hard links dereferenced), every .git left out
# The patch is made outside, from the export and the original base, by git the
# agent never touched: nothing here decides what the agent changed.
set -eu
inputs=/run/blacksand/inputs
repo=/workspace/repo
bundle=/tmp/blacksand/repo.bundle

case "${1:-}" in
receive)
  mkdir -p /tmp/blacksand
  cat > "$bundle"
  ;;
prepare)
  git -c core.hooksPath=/dev/null clone --quiet --no-hardlinks "$bundle" "$repo"
  rm -f "$bundle"
  echo "base=$(git -C "$repo" rev-parse HEAD)"
  echo "uid=$(id -u)"
  echo "kernel=$(uname -r)"
  # gVisor's kernel greets with its own dmesg line, so this shows the runtime in effect.
  echo "dmesg=$(dmesg 2>/dev/null | head -n 1 || true)"
  ;;
agent)
  cd "$repo"
  exec sh "$inputs/agent.sh" < "$inputs/prompt"
  ;;
freeze)
  # kill -1 signals every process this user may signal except PID 1 (sleep) and
  # this shell. A killed process takes a moment to go, so look again, up to 5 s.
  tries=0
  while :; do
    kill -KILL -1 2>/dev/null || true
    left=""
    for proc in /proc/[0-9]*; do
      pid=${proc#/proc/}
      [ "$pid" = 1 ] || [ "$pid" = $$ ] || [ ! -r "$proc/stat" ] && continue
      read -r stat < "$proc/stat" || continue
      case "$stat" in *") Z "*) continue ;; esac # a zombie can't run
      left="$left $pid"
    done
    tries=$((tries + 1))
    [ -z "$left" ] || [ "$tries" -ge 50 ] && break
    sleep 0.1
  done
  for pid in $left; do echo "running=$pid"; done
  ;;
export)
  # --hard-dereference: each name of a hard-linked file carries its own bytes, so no name depends on another being kept.
  tar -C "$repo" --format=posix --hard-dereference --exclude=.git -cf - .
  ;;
*)
  echo "usage: steps.sh receive|prepare|agent|freeze|export" >&2
  exit 2
  ;;
esac
