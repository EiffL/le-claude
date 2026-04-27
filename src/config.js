/**
 * Configuration management for le-claude.
 *
 * Stores config in ~/.config/le-claude/config.json
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const PROVIDER_BASE_URLS = {
  albert: 'https://albert.api.etalab.gouv.fr/v1',
  ilaas: 'https://llm.ilaas.fr/v1',
};

const DEFAULT_BASE_URL = PROVIDER_BASE_URLS.albert;

/** Migrate old flat config to multi-provider shape. Returns same ref if already new shape. */
export function migrateConfig(config) {
  if (!config || config.providers) return config;
  return {
    defaultProvider: 'albert',
    providers: {
      albert: {
        baseUrl: config.baseUrl || PROVIDER_BASE_URLS.albert,
        apiKey: config.apiKey,
        model: config.model,
      },
    },
    braveApiKey: config.braveApiKey || '',
  };
}

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
  return path.join(xdg, 'le-claude');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

/** Load saved config, or return null if none exists. Auto-migrates old flat shape. */
export function loadConfig() {
  let data;
  try {
    data = fs.readFileSync(configPath(), 'utf-8');
  } catch {
    return null;
  }
  const raw = JSON.parse(data);
  const config = migrateConfig(raw);
  if (config !== raw) {
    try { saveConfig(config); } catch { /* best-effort write-back */ }
  }
  return config;
}

/** Save config to disk. */
export function saveConfig(config) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600, // readable only by owner
  });
}

// ---------------------------------------------------------------------------
// Interactive setup
// ---------------------------------------------------------------------------

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

/** Fetch available models from the provider API. Falls back to all models if filter yields none. */
export async function fetchModels(baseUrl, apiKey) {
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();

  const all = (data.data || []).sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const filtered = all.filter(m => m.type === 'text-generation' || m.id?.includes('Instruct'));
  return filtered.length > 0 ? filtered : all;
}

/** Interactive model picker. Shows available models and returns chosen ID. */
async function pickModel(rl, models) {
  if (models.length === 0) {
    console.error('  No text-generation models found. Enter model ID manually.');
    return await ask(rl, '  Model ID: ');
  }
  console.error('');
  console.error('  Available models:');
  models.forEach((m, i) => {
    const type = m.type ? ` (${m.type})` : '';
    console.error(`    ${i + 1}. ${m.id}${type}`);
  });
  console.error('');
  const choice = await ask(rl, '  Select model [1]: ');
  const idx = (parseInt(choice, 10) || 1) - 1;
  return models[Math.max(0, Math.min(idx, models.length - 1))].id;
}

/** Fetch models and interactively select one. Returns model ID string. */
export async function selectModel(baseUrl, apiKey) {
  const models = await fetchModels(baseUrl, apiKey);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await pickModel(rl, models);
  } finally {
    rl.close();
  }
}

/** Run interactive setup. Returns config object. */
export async function interactiveSetup(existingConfig = null) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // use stderr so stdout stays clean for claude
  });

  try {
    console.error('');
    console.error('  le-claude - Use Claude Code with Albert API');
    console.error('');

    if (!existingConfig) {
      // First-time setup: ask for everything
      console.error('  No configuration found. Let\'s set things up!');
      console.error('');
      return await fullSetup(rl, null);
    }

    // Reconfiguration: let the user choose what to change
    console.error('  Current configuration:');
    console.error(`    API key:       ${existingConfig.apiKey.slice(0, 8)}...`);
    console.error(`    Model:         ${existingConfig.model}`);
    console.error(`    Web search:    ${existingConfig.braveApiKey ? 'Brave Search' : 'Marginalia (default)'}`);
    console.error('');
    console.error('  What would you like to change?');
    console.error('    1. API key');
    console.error('    2. Default model');
    console.error('    3. Web search provider');
    console.error('    4. Everything');
    console.error('');
    const choice = await ask(rl, '  Choice [2]: ');
    const option = parseInt(choice, 10) || 2;

    let apiKey = existingConfig.apiKey;
    let baseUrl = existingConfig.baseUrl || DEFAULT_BASE_URL;
    let model = existingConfig.model;
    let braveApiKey = existingConfig.braveApiKey || '';

    if (option === 1 || option === 4) {
      const newKey = await ask(rl, '  New Albert API Key: ');
      if (!newKey.trim()) {
        console.error('  API key is required.');
        process.exit(1);
      }
      apiKey = newKey.trim();

      // Test the new key
      process.stderr.write('  Testing connection... ');
      try {
        await fetchModels(baseUrl, apiKey);
        console.error('ok');
      } catch (err) {
        console.error(`failed: ${err.message}`);
        console.error('  Please check your API key and try again.');
        process.exit(1);
      }
    }

    if (option === 2 || option === 4) {
      process.stderr.write('  Fetching models... ');
      let models;
      try {
        models = await fetchModels(baseUrl, apiKey);
        console.error('ok');
      } catch (err) {
        console.error(`failed: ${err.message}`);
        console.error('  Could not fetch models. Please check your API key.');
        process.exit(1);
      }
      model = await pickModel(rl, models);
    }

    if (option === 3 || option === 4) {
      braveApiKey = await askBraveKey(rl);
    }

    const config = { apiKey, model, baseUrl, braveApiKey };
    saveConfig(config);
    console.error('');
    console.error(`  Configuration saved to ${configPath()}`);
    console.error('');
    return config;
  } finally {
    rl.close();
  }
}

/** Ask for optional Brave Search API key. */
async function askBraveKey(rl) {
  console.error('');
  console.error('  Web search uses Marginalia (Swedish, EU-funded) by default — no key needed.');
  console.error('  For better results, you can add a free Brave Search API key.');
  const key = await ask(rl, '  Brave Search API key (Enter to skip): ');
  return key.trim();
}

/** Full first-time setup flow. */
async function fullSetup(rl, existingConfig) {
  const apiKey = await ask(rl, '  Albert API Key: ');
  if (!apiKey.trim()) {
    console.error('  API key is required.');
    process.exit(1);
  }

  const baseUrl = existingConfig?.baseUrl || DEFAULT_BASE_URL;

  // Test connection
  process.stderr.write('  Testing connection... ');
  let models;
  try {
    models = await fetchModels(baseUrl, apiKey.trim());
    console.error('ok');
  } catch (err) {
    console.error(`failed: ${err.message}`);
    console.error('  Please check your API key and try again.');
    process.exit(1);
  }

  // Model selection
  const model = await pickModel(rl, models);

  // Optional Brave Search key
  const braveApiKey = await askBraveKey(rl);

  const config = {
    apiKey: apiKey.trim(),
    model,
    baseUrl,
    braveApiKey,
  };

  saveConfig(config);
  console.error('');
  console.error(`  Configuration saved to ${configPath()}`);
  console.error('');

  return config;
}
