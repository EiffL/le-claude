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
