import os from 'os';
import fs from 'fs';
import path from 'path';
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import {
  getDocsConfig,
  resolveDocsCachePath,
  normalizeSafeRelativePath
} from '../src/docs/config.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.HAPPY_CONFIG_PATH = path.join(os.tmpdir(), `happy-docs-missing-${process.pid}.json`);
});

afterEach(() => {
  process.env = originalEnv;
});

describe('docs config', () => {
  test('uses the default cache directory under the user home', () => {
    delete process.env.HAPPY_DOCS_CACHE_DIR;
    const config = getDocsConfig();
    expect(config.cacheDir).toBe(path.join(os.homedir(), '.demoenvservicenowmcp', 'docs', 'servicenow'));
    expect(config.localIndexEnabled).toBe(false);
    expect(config.enableVector).toBe(false);
  });

  test('allows cache directory and vector flag through env vars', () => {
    process.env.HAPPY_DOCS_CACHE_DIR = '/tmp/happy-docs';
    process.env.HAPPY_DOCS_ENABLE_LOCAL_INDEX = 'true';
    process.env.HAPPY_DOCS_ENABLE_VECTOR = 'true';
    const config = getDocsConfig();
    expect(config.cacheDir).toBe('/tmp/happy-docs');
    expect(config.localIndexEnabled).toBe(true);
    expect(config.enableVector).toBe(true);
  });

  test('loads docs system properties from the local config file', () => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'happy-docs-config-')), 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      docs: {
        cacheDir: '/tmp/from-config',
        localIndexEnabled: true,
        enableVector: true,
        embeddingProvider: 'local',
        githubToken: 'from-config'
      }
    }));
    process.env.HAPPY_CONFIG_PATH = configPath;

    const config = getDocsConfig();

    expect(config).toMatchObject({
      cacheDir: '/tmp/from-config',
      localIndexEnabled: true,
      enableVector: true,
      embeddingProvider: 'local',
      githubToken: 'from-config'
    });
  });

  test('rejects path traversal for relative docs paths', () => {
    expect(() => normalizeSafeRelativePath('../secret.md')).toThrow(/Unsafe docs path/);
    expect(() => normalizeSafeRelativePath('/absolute.md')).toThrow(/Unsafe docs path/);
    expect(normalizeSafeRelativePath('docs/platform/foo.md')).toBe('docs/platform/foo.md');
  });

  test('resolves safe cache paths inside the cache directory', () => {
    const fullPath = resolveDocsCachePath('/tmp/cache', 'australia/foo/bar.md');
    expect(fullPath).toBe(path.join('/tmp/cache', 'australia/foo/bar.md'));
  });
});
