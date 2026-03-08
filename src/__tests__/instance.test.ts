import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  deriveInstanceName,
  resolveCtiHome,
  getLaunchdLabel,
} from '../instance.js';

describe('resolveCtiHome', () => {
  it('uses the legacy default directory when no instance is set', () => {
    assert.equal(
      resolveCtiHome({ homeDir: '/Users/tester' }),
      path.join('/Users/tester', '.claude-to-im')
    );
  });

  it('uses an instance-specific directory when the instance is explicit', () => {
    assert.equal(
      resolveCtiHome({
        homeDir: '/Users/tester',
        explicitInstance: 'codex',
      }),
      path.join('/Users/tester', '.claude-to-im-codex')
    );
  });
});

describe('deriveInstanceName', () => {
  it('uses default instance for the default cti home', () => {
    assert.equal(
      deriveInstanceName({
        ctiHome: path.join('/Users/tester', '.claude-to-im'),
        homeDir: '/Users/tester',
      }),
      'default'
    );
  });

  it('derives a distinct instance name from a non-default cti home', () => {
    assert.equal(
      deriveInstanceName({
        ctiHome: path.join('/Users/tester', '.claude-to-im-codex'),
        homeDir: '/Users/tester',
      }),
      'codex'
    );
  });

  it('prefers an explicit instance name', () => {
    assert.equal(
      deriveInstanceName({
        ctiHome: path.join('/Users/tester', '.claude-to-im-codex'),
        homeDir: '/Users/tester',
        explicitInstance: 'robot-feishu-2',
      }),
      'robot-feishu-2'
    );
  });
});

describe('getLaunchdLabel', () => {
  it('keeps the legacy label for the default instance', () => {
    assert.equal(getLaunchdLabel('default'), 'com.claude-to-im.bridge');
  });

  it('adds the instance suffix for non-default instances', () => {
    assert.equal(
      getLaunchdLabel('codex'),
      'com.claude-to-im.bridge.codex'
    );
  });
});
