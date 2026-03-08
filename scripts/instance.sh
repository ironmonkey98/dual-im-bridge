#!/usr/bin/env bash

sanitize_instance_name() {
  local value="${1:-}"
  value=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
  value=$(printf '%s' "$value" | sed -E 's/[^a-z0-9._-]+/-/g; s/^[.-]+//; s/[.-]+$//')
  if [ -z "$value" ]; then
    printf 'default'
  else
    printf '%s' "$value"
  fi
}

resolve_cti_home() {
  if [ -n "${CTI_HOME:-}" ]; then
    printf '%s' "$CTI_HOME"
    return
  fi

  local instance
  instance=$(sanitize_instance_name "${CTI_INSTANCE:-}")
  if [ -z "${CTI_INSTANCE:-}" ] || [ "$instance" = "default" ]; then
    printf '%s/.claude-to-im' "$HOME"
  else
    printf '%s/.claude-to-im-%s' "$HOME" "$instance"
  fi
}

derive_instance_name() {
  if [ -n "${CTI_INSTANCE:-}" ]; then
    sanitize_instance_name "$CTI_INSTANCE"
    return
  fi

  local cti_home="${1:-$(resolve_cti_home)}"
  local default_home="$HOME/.claude-to-im"
  if [ "$cti_home" = "$default_home" ]; then
    printf 'default'
    return
  fi

  local base
  base=$(basename "$cti_home")
  if [ "$base" = ".claude-to-im" ]; then
    printf 'default'
    return
  fi

  case "$base" in
    .claude-to-im-*)
      sanitize_instance_name "${base#.claude-to-im-}"
      ;;
    *)
      sanitize_instance_name "$base"
      ;;
  esac
}

launchd_label_for_instance() {
  local instance="${1:-default}"
  instance=$(sanitize_instance_name "$instance")
  if [ "$instance" = "default" ]; then
    printf 'com.claude-to-im.bridge'
  else
    printf 'com.claude-to-im.bridge.%s' "$instance"
  fi
}
