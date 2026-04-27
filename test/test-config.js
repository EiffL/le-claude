import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateConfig, loadConfig, saveConfig, fetchModels } from '../src/config.js';

describe('migrateConfig', () => {
  it('migrates old flat shape to new providers map', () => {
    const old = {
      apiKey: 'sk-test-123',
      model: 'Albert-Large',
      baseUrl: 'https://albert.api.etalab.gouv.fr/v1',
      braveApiKey: 'brave-456',
    };
    const result = migrateConfig(old);
    assert.deepEqual(result, {
      defaultProvider: 'albert',
      providers: {
        albert: {
          baseUrl: 'https://albert.api.etalab.gouv.fr/v1',
          apiKey: 'sk-test-123',
          model: 'Albert-Large',
        },
      },
      braveApiKey: 'brave-456',
    });
  });

  it('fills missing baseUrl with Albert default when migrating', () => {
    const old = { apiKey: 'sk-x', model: 'M' };
    const result = migrateConfig(old);
    assert.equal(result.providers.albert.baseUrl, 'https://albert.api.etalab.gouv.fr/v1');
    assert.equal(result.braveApiKey, '');
  });

  it('returns new-shape config unchanged (same reference)', () => {
    const config = {
      defaultProvider: 'albert',
      providers: { albert: { baseUrl: 'https://albert.api.etalab.gouv.fr/v1', apiKey: 'sk-1', model: 'M' } },
      braveApiKey: '',
    };
    assert.strictEqual(migrateConfig(config), config);
  });

  it('returns null unchanged', () => {
    assert.strictEqual(migrateConfig(null), null);
  });
});

describe('loadConfig', () => {
  let tmpDir;
  const origXdg = process.env.XDG_CONFIG_HOME;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-claude-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true });
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  });

  it('returns null when no config file exists', () => {
    assert.strictEqual(loadConfig(), null);
  });

  it('auto-migrates old flat config and writes new shape to disk', () => {
    const dir = path.join(tmpDir, 'le-claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ apiKey: 'sk-old', model: 'OldModel', baseUrl: 'https://albert.api.etalab.gouv.fr/v1', braveApiKey: '' }),
    );

    const config = loadConfig();
    assert.equal(config.defaultProvider, 'albert');
    assert.equal(config.providers.albert.apiKey, 'sk-old');
    assert.equal(config.providers.albert.model, 'OldModel');

    // Migration was written back to disk
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    assert.ok(written.providers, 'migrated config should have providers on disk');
    assert.ok(!written.apiKey, 'old apiKey field should be gone');
  });

  it('loads new multi-provider config without touching it', () => {
    const config = {
      defaultProvider: 'ilaas',
      providers: {
        ilaas: { baseUrl: 'https://llm.ilaas.fr/v1', apiKey: 'sk-ilaas', model: 'ILaaS-Model' },
      },
      braveApiKey: '',
    };
    saveConfig(config);
    const loaded = loadConfig();
    assert.deepEqual(loaded, config);
  });
});
