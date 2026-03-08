/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 *
 * Converts SDK stream events into the SSE format expected by
 * the claude-to-im bridge conversation engine.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { LLMProvider, StreamChatParams, FileAttachment } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';

import { sseEvent } from './sse-utils.js';

// ── Environment isolation ──

/** Env vars always passed through to the CLI subprocess. */
const ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'COLORTERM',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
]);

/** Prefixes that are always stripped (even in inherit mode). */
const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

function getClaudeSkillsDir(): string {
  const home = process.env.HOME || '';
  return home ? `${home}/.claude/skills` : '.claude/skills';
}

export function listInstalledSkillNames(skillsDir = getClaudeSkillsDir()): string[] {
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(`${skillsDir}/${name}/SKILL.md`))
      .sort();
  } catch {
    return [];
  }
}

function createSkillAliases(skillName: string): string[] {
  const aliases = new Set<string>();
  const collapsed = skillName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (collapsed && collapsed !== skillName.toLowerCase()) aliases.add(collapsed);

  if (skillName === 'frontend-design') {
    aliases.add('frontdesign');
    aliases.add('frontenddesign');
  }

  return [...aliases];
}

export function buildSkillDiscoveryAppend(skillNames: string[]): string {
  if (skillNames.length === 0) return '';

  const lines = [
    'Installed local Claude skills are available in this session.',
    'When a user explicitly asks to use a skill, treat that as configured and use it instead of saying it is unavailable.',
    'Known skills in this environment:',
  ];

  for (const skillName of skillNames) {
    const aliases = createSkillAliases(skillName);
    lines.push(aliases.length > 0
      ? `- ${skillName} (aliases: ${aliases.join(', ')})`
      : `- ${skillName}`);
  }

  lines.push('If the user message starts with an unknown slash command like /frontend-design, interpret it as a request to use that installed skill when the name matches the list above.');

  return lines.join('\n');
}

export function normalizeSlashSkillInvocation(prompt: string, skillNames: string[]): string {
  const aliasMap = new Map<string, string>();

  for (const skillName of skillNames) {
    aliasMap.set(skillName.toLowerCase(), skillName);
    for (const alias of createSkillAliases(skillName)) aliasMap.set(alias.toLowerCase(), skillName);
  }

  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/([a-zA-Z0-9-]+)(?:\s+(.*))?$/s);
  if (!match) return prompt;

  const resolved = aliasMap.get(match[1].toLowerCase());
  if (!resolved) return prompt;

  const remainder = (match[2] || '').trim();
  return remainder
    ? `Use the local skill "${resolved}" for this request: ${remainder}`
    : `Use the local skill "${resolved}" for this request.`;
}

function resolveRequestedSkillName(prompt: string, skillNames: string[]): string | null {
  const lowerPrompt = prompt.toLowerCase();
  const aliasMap = new Map<string, string>();

  for (const skillName of skillNames) {
    aliasMap.set(skillName.toLowerCase(), skillName);
    for (const alias of createSkillAliases(skillName)) aliasMap.set(alias.toLowerCase(), skillName);
  }

  const slashMatches = prompt.match(/\/([a-zA-Z0-9-]+)/g) || [];
  for (const match of slashMatches) {
    const key = match.slice(1).toLowerCase();
    const resolved = aliasMap.get(key);
    if (resolved) return resolved;
  }

  for (const [alias, skillName] of aliasMap.entries()) {
    if (lowerPrompt.includes(`${alias} skill`) || lowerPrompt.includes(`使用${alias}`) || lowerPrompt.includes(`use ${alias}`)) {
      return skillName;
    }
  }

  return null;
}

function readSkillMarkdown(skillName: string, skillsDir = getClaudeSkillsDir()): string | null {
  try {
    const skillPath = `${skillsDir}/${skillName}/SKILL.md`;
    return fs.readFileSync(skillPath, 'utf8');
  } catch {
    return null;
  }
}

export function augmentPromptWithSkillContext(prompt: string, skillsDir = getClaudeSkillsDir()): string {
  const skillNames = listInstalledSkillNames(skillsDir);
  const skillName = resolveRequestedSkillName(prompt, skillNames);
  if (!skillName) return prompt;

  const skillMarkdown = readSkillMarkdown(skillName, skillsDir);
  if (!skillMarkdown) return prompt;

  const cleanedPrompt = prompt.replace(new RegExp(`/(${[skillName, ...createSkillAliases(skillName)].join('|')})`, 'ig'), '').trim();

  return [
    `The user explicitly requested local skill "${skillName}".`,
    'Treat this skill as available and follow it instead of claiming it is unavailable.',
    `Skill name: ${skillName}`,
    'Skill content:',
    skillMarkdown,
    '',
    'User request:',
    cleanedPrompt || prompt,
  ].join('\n');
}

export function isRetryableClaudeExitError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Claude Code process exited with code 1');
}

export function shouldRetryFreshSessionClaudeExit(
  params: Pick<StreamChatParams, 'sdkSessionId'>,
  err: unknown,
): boolean {
  return !params.sdkSessionId && isRetryableClaudeExitError(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a clean env for the CLI subprocess.
 *
 * CTI_ENV_ISOLATION (default "strict"):
 *   "strict"  — only whitelist + CTI_* + ANTHROPIC_* from config.env
 *   "inherit" — full parent env minus CLAUDECODE
 */
export function buildSubprocessEnv(): Record<string, string> {
  const mode = process.env.CTI_ENV_ISOLATION || 'strict';
  const out: Record<string, string> = {};

  if (mode === 'inherit') {
    // Pass everything except always-stripped vars
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_ALWAYS_STRIP.includes(k)) continue;
      out[k] = v;
    }
  } else {
    // Strict: whitelist only
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) { out[k] = v; continue; }
      // Pass through CTI_* so skill config is available
      if (k.startsWith('CTI_')) { out[k] = v; continue; }
    }
    // ANTHROPIC_* should come from config.env, not parent process.
    // Only pass them if CTI_ANTHROPIC_PASSTHROUGH is explicitly set.
    if (process.env.CTI_ANTHROPIC_PASSTHROUGH === 'true') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k.startsWith('ANTHROPIC_')) out[k] = v;
      }
    }

    // In codex/auto mode, pass through OPENAI_* / CODEX_* env vars
    const runtime = process.env.CTI_RUNTIME || 'claude';
    if (runtime === 'codex' || runtime === 'auto') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && (k.startsWith('OPENAI_') || k.startsWith('CODEX_'))) out[k] = v;
      }
    }
  }

  return out;
}

// ── Claude CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the path to the `claude` CLI executable.
 * Priority: CTI_CLAUDE_CODE_EXECUTABLE env → which/where command → common install paths.
 */
export function resolveClaudeCliPath(): string | undefined {
  // 1. Explicit env var
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  // 2. Platform-specific command (which for Unix, where for Windows)
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where claude' : 'which claude';
  try {
    const resolved = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0];
    if (resolved && isExecutable(resolved)) return resolved;
  } catch {
    // not found in PATH
  }

  // 3. Common install locations
  const candidates = isWindows
    ? [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe` : '',
        'C:\\Program Files\\claude\\claude.exe',
      ].filter(Boolean)
    : [
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        `${process.env.HOME}/.npm-global/bin/claude`,
        `${process.env.HOME}/.local/bin/claude`,
        `${process.env.HOME}/.claude/local/claude`,
      ];
  for (const p of candidates) {
    if (p && isExecutable(p)) return p;
  }

  return undefined;
}

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

/**
 * Build a prompt for query(). When files are present, returns an async
 * iterable that yields a single SDKUserMessage with multi-modal content
 * (image blocks + text). Otherwise returns the plain text string.
 */
function buildPrompt(
  text: string,
  files?: FileAttachment[],
): string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }> {
  const imageFiles = files?.filter(f => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles || imageFiles.length === 0) return text;

  const contentBlocks: unknown[] = [];

  for (const file of imageFiles) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as ImageMediaType,
        data: file.data,
      },
    });
  }

  if (text.trim()) {
    contentBlocks.push({ type: 'text', text });
  }

  const msg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: '',
  };

  return (async function* () { yield msg; })();
}

export class SDKLLMProvider implements LLMProvider {
  private cliPath: string | undefined;
  private autoApprove: boolean;

  constructor(private pendingPerms: PendingPermissions, cliPath?: string, autoApprove = false) {
    this.cliPath = cliPath;
    this.autoApprove = autoApprove;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;

    return new ReadableStream({
      start(controller) {
        (async () => {
          const installedSkillNames = listInstalledSkillNames();
          const normalizedPromptText = normalizeSlashSkillInvocation(params.prompt, installedSkillNames);
          const skillDiscoveryAppend = buildSkillDiscoveryAppend(installedSkillNames);
          const enrichedPromptText = augmentPromptWithSkillContext(normalizedPromptText);
          const prompt = buildPrompt(enrichedPromptText, params.files);

          const runQueryOnce = async () => {
            const cleanEnv = buildSubprocessEnv();

            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model: params.model,
              resume: params.sdkSessionId || undefined,
              abortController: params.abortController,
              permissionMode: (params.permissionMode as 'default' | 'acceptEdits' | 'plan') || undefined,
              includePartialMessages: true,
              env: cleanEnv,
              canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string; suggestions?: string[] },
                ): Promise<PermissionResult> => {
                  if (autoApprove) {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }

                  controller.enqueue(
                    sseEvent('permission_request', {
                      permissionRequestId: opts.toolUseID,
                      toolName,
                      toolInput: input,
                      suggestions: opts.suggestions || [],
                    }),
                  );

                  const result = await pendingPerms.waitFor(opts.toolUseID);

                  if (result.behavior === 'allow') {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }
                  return {
                    behavior: 'deny' as const,
                    message: result.message || 'Denied by user',
                  };
                },
            };
            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }
            if (skillDiscoveryAppend) {
              queryOptions.systemPrompt = {
                type: 'preset',
                preset: 'claude_code',
                append: skillDiscoveryAppend,
              };
            }

            const q = query({
              prompt: prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            for await (const msg of q) {
              handleMessage(msg, controller);
            }
          };

          try {
            await runQueryOnce();
            controller.close();
          } catch (err) {
            if (shouldRetryFreshSessionClaudeExit(params, err)) {
              console.warn(
                '[llm-provider] Retrying fresh-session Claude exit code 1',
                JSON.stringify({
                  cwd: params.workingDirectory || '',
                  model: params.model || '',
                  hasSkillContext: enrichedPromptText !== normalizedPromptText,
                }),
              );
              try {
                await sleep(250);
                await runQueryOnce();
                controller.close();
                return;
              } catch (retryErr) {
                console.error(
                  '[llm-provider] Fresh-session retry failed:',
                  retryErr instanceof Error ? retryErr.stack || retryErr.message : retryErr,
                );
                err = retryErr;
              }
            }

            const message = err instanceof Error ? err.message : String(err);
            console.error('[llm-provider] SDK query error:', err instanceof Error ? err.stack || err.message : err);
            controller.enqueue(sseEvent('error', message));
            controller.close();
          }
        })();
      },
    });
  }
}

function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
): void {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        // Emit delta text — the bridge accumulates on its side
        controller.enqueue(sseEvent('text', event.delta.text));
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        controller.enqueue(
          sseEvent('tool_use', {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          }),
        );
      }
      break;
    }

    case 'assistant': {
      // Full assistant message — extract content blocks
      // Text deltas are already handled by stream_event; this handles
      // any tool_use blocks not caught by partial streaming.
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            controller.enqueue(
              sseEvent('tool_use', {
                id: block.id,
                name: block.name,
                input: block.input,
              }),
            );
          }
        }
      }
      break;
    }

    case 'user': {
      // User messages contain tool_result blocks from completed tool calls
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            const text = typeof rb.content === 'string'
              ? rb.content
              : JSON.stringify(rb.content ?? '');
            controller.enqueue(
              sseEvent('tool_result', {
                tool_use_id: rb.tool_use_id,
                content: text,
                is_error: rb.is_error || false,
              }),
            );
          }
        }
      }
      break;
    }

    case 'result': {
      if (msg.subtype === 'success') {
        controller.enqueue(
          sseEvent('result', {
            session_id: msg.session_id,
            is_error: msg.is_error,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          }),
        );
      } else {
        // Error result
        const errors =
          'errors' in msg && Array.isArray(msg.errors)
            ? msg.errors.join('; ')
            : 'Unknown error';
        controller.enqueue(sseEvent('error', errors));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(
          sseEvent('status', {
            session_id: msg.session_id,
            model: msg.model,
          }),
        );
      }
      break;
    }

    default:
      // Ignore other message types (auth_status, task_notification, etc.)
      break;
  }
}
