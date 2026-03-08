import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isRetryableClaudeExitError,
  augmentPromptWithSkillContext,
  buildSkillDiscoveryAppend,
  normalizeSlashSkillInvocation,
  shouldRetryFreshSessionClaudeExit,
} from '../llm-provider.js';

describe('buildSkillDiscoveryAppend', () => {
  it('includes installed skill names and collapsed aliases', () => {
    const prompt = buildSkillDiscoveryAppend(['frontend-design', 'claude-to-im', 'content-creator']);
    assert.match(prompt, /frontend-design/);
    assert.match(prompt, /frontdesign/);
    assert.match(prompt, /claude-to-im/);
    assert.match(prompt, /claudetoim/);
  });

  it('returns empty string when no skills are available', () => {
    assert.equal(buildSkillDiscoveryAppend([]), '');
  });
});

describe('normalizeSlashSkillInvocation', () => {
  it('rewrites slash skill invocation into natural-language request', () => {
    const result = normalizeSlashSkillInvocation('/frontend-design 绘制办公室行政AI自救指南', ['frontend-design']);
    assert.equal(result, 'Use the local skill "frontend-design" for this request: 绘制办公室行政AI自救指南');
  });

  it('supports collapsed alias slash like /frontdesign', () => {
    const result = normalizeSlashSkillInvocation('/frontdesign 做一个 HTML 页面', ['frontend-design']);
    assert.equal(result, 'Use the local skill "frontend-design" for this request: 做一个 HTML 页面');
  });

  it('keeps prompt unchanged when slash command is not a local skill', () => {
    assert.equal(normalizeSlashSkillInvocation('/help', ['frontend-design']), '/help');
  });
});

describe('augmentPromptWithSkillContext', () => {
  it('injects explicitly requested slash skill content', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-skill-test-'));
    const skillDir = path.join(tmp, 'frontend-design');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: frontend-design\ndescription: Use when building polished frontend UI\n---\n# Frontend Design\nUse gradients.', 'utf8');

    const result = augmentPromptWithSkillContext('/frontend-design 绘制页面', tmp);
    assert.match(result, /Skill name: frontend-design/);
    assert.match(result, /# Frontend Design/);
    assert.match(result, /User request:\n绘制页面/);
  });

  it('supports collapsed alias like frontdesign', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-skill-test-'));
    const skillDir = path.join(tmp, 'frontend-design');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: frontend-design\ndescription: Use when building polished frontend UI\n---\n# Frontend Design', 'utf8');

    const result = augmentPromptWithSkillContext('使用 /frontdesign 绘制办公室行政ai自救指南', tmp);
    assert.match(result, /Skill name: frontend-design/);
  });

  it('keeps prompt unchanged when no skill is matched', () => {
    assert.equal(augmentPromptWithSkillContext('普通对话', '/tmp/non-existent-skills'), '普通对话');
  });
});

describe('fresh-session retry policy', () => {
  it('matches Claude code 1 exit errors', () => {
    assert.equal(isRetryableClaudeExitError(new Error('Claude Code process exited with code 1')), true);
  });

  it('ignores other Claude exit codes', () => {
    assert.equal(isRetryableClaudeExitError(new Error('Claude Code process exited with code 2')), false);
  });

  it('retries only for fresh sessions with retryable error', () => {
    assert.equal(
      shouldRetryFreshSessionClaudeExit({ sdkSessionId: undefined } as never, new Error('Claude Code process exited with code 1')),
      true,
    );
    assert.equal(
      shouldRetryFreshSessionClaudeExit({ sdkSessionId: 'existing-session' } as never, new Error('Claude Code process exited with code 1')),
      false,
    );
  });
});
