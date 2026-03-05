---
name: claude-to-im
description: |
  Bridge Claude Code to IM platforms (Telegram, Discord, Feishu/Lark).
  Start a background daemon that forwards IM messages to Claude Code sessions.
  Commands: setup, start, stop, status, logs, reconfigure, doctor
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Claude-to-IM Bridge Skill

You are managing the Claude-to-IM bridge. The skill directory is at `$SKILL_DIR`.
User data is stored at `~/.claude-to-im/`.

Parse the first word of `$ARGUMENTS` as the subcommand.

**IMPORTANT:** Before asking users for any platform credentials, first read `$SKILL_DIR/docs/setup-guides.md` to get the detailed step-by-step guidance for that platform. Present the relevant guide text to the user via AskUserQuestion so they know exactly what to do.

## Subcommands

### `setup`

Run an interactive setup wizard. Present each question with AskUserQuestion.

**Step 1 — Choose channels**

Ask which channels to enable (telegram, discord, feishu). Accept comma-separated input. Briefly describe each:
- **telegram** — Best for personal use. Streaming preview, inline permission buttons.
- **discord** — Good for team use. Server/channel/user-level access control.
- **feishu** (Lark) — For Feishu/Lark teams. Event-based messaging.

**Step 2 — Collect tokens per channel**

For each enabled channel, read `$SKILL_DIR/docs/setup-guides.md` and present the relevant platform guide to the user. Collect:

- **Telegram**: Bot Token, Allowed User IDs (optional)
- **Discord**: Bot Token, Allowed User IDs (optional), Allowed Channel IDs (optional), Allowed Guild IDs (optional)
- **Feishu**: App ID, App Secret, Domain (optional), Allowed User IDs (optional). Make sure to guide through all 4 steps (A: batch permissions, B: enable bot, C: events & callbacks with long connection, D: publish version).

**Step 3 — General settings**

Ask for default working directory, model, and mode:
- **Working Directory**: default `$CWD`
- **Model**: `claude-sonnet-4-20250514` (default), `claude-opus-4-6`, `claude-haiku-4-5-20251001`
- **Mode**: `code` (default), `plan`, `ask`

**Step 4 — Write config and validate**

1. Only echo the last 4 characters of any token/secret in the confirmation summary
2. Use Bash to create directory structure: `mkdir -p ~/.claude-to-im/{data,logs,runtime,data/messages}`
3. Use Write to create `~/.claude-to-im/config.env` with all settings in KEY=VALUE format
4. Use Bash to set permissions: `chmod 600 ~/.claude-to-im/config.env`
5. Validate tokens:
   - Telegram: `curl -s "https://api.telegram.org/bot${TOKEN}/getMe"` — check for `"ok":true`
   - Feishu: `curl -s -X POST "${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" -H "Content-Type: application/json" -d '{"app_id":"...","app_secret":"..."}'` — check for `"code":0`
   - Discord: verify token matches format `[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
6. Report results with a summary table. If any validation fails, explain what might be wrong and how to fix it.

### `start`

Run: `bash "$SKILL_DIR/scripts/daemon.sh" start`

Show the output to the user. If it fails, suggest running `doctor`.

### `stop`

Run: `bash "$SKILL_DIR/scripts/daemon.sh" stop`

### `status`

Run: `bash "$SKILL_DIR/scripts/daemon.sh" status`

### `logs`

Extract optional line count N from arguments (default 50).
Run: `bash "$SKILL_DIR/scripts/daemon.sh" logs N`

### `reconfigure`

1. Read current config from `~/.claude-to-im/config.env`
2. Show current settings in a clear table format, with all secrets masked (only last 4 chars visible)
3. Use AskUserQuestion to ask what the user wants to change
4. When collecting new values, read `$SKILL_DIR/docs/setup-guides.md` and present the relevant guide for that field
5. Update the config file atomically (write to tmp, rename)
6. Re-validate any changed tokens
7. Remind user: "Run `/claude-to-im stop` then `/claude-to-im start` to apply the changes."

### `doctor`

Run: `bash "$SKILL_DIR/scripts/doctor.sh"`

Show results and suggest fixes for any failures.

## Notes

- Always mask secrets in output (show only last 4 characters)
- If config.env doesn't exist and user runs start/status/logs, suggest running setup first
- The daemon runs as a background Node.js process managed by PID file
