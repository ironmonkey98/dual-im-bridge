#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/dual-instance.sh start
  bash scripts/dual-instance.sh stop
  bash scripts/dual-instance.sh restart
  bash scripts/dual-instance.sh status
  bash scripts/dual-instance.sh logs [N]
  bash scripts/dual-instance.sh doctor

Instances:
  cc     -> ~/.claude-to-im-cc
  codex  -> ~/.claude-to-im-codex
EOF
}

run_for_instance() {
  local instance="$1"
  shift
  printf '\n=== %s ===\n' "$instance"
  CTI_INSTANCE="$instance" bash "$SKILL_DIR/scripts/daemon.sh" "$@"
}

doctor_for_instance() {
  local instance="$1"
  printf '\n=== %s ===\n' "$instance"
  CTI_INSTANCE="$instance" bash "$SKILL_DIR/scripts/doctor.sh"
}

command="${1:-status}"
shift || true

case "$command" in
  start)
    run_for_instance cc start
    run_for_instance codex start
    ;;
  stop)
    run_for_instance cc stop
    run_for_instance codex stop
    ;;
  restart)
    run_for_instance cc stop || true
    run_for_instance codex stop || true
    run_for_instance cc start
    run_for_instance codex start
    ;;
  status)
    run_for_instance cc status
    run_for_instance codex status
    ;;
  logs)
    lines="${1:-50}"
    printf '\n=== cc ===\n'
    CTI_INSTANCE=cc bash "$SKILL_DIR/scripts/daemon.sh" logs "$lines"
    printf '\n=== codex ===\n'
    CTI_INSTANCE=codex bash "$SKILL_DIR/scripts/daemon.sh" logs "$lines"
    ;;
  doctor)
    doctor_for_instance cc
    doctor_for_instance codex
    ;;
  *)
    usage
    exit 1
    ;;
esac
