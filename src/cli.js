/**
 * CLI entry point for le-claude.
 *
 * Orchestrates: config → proxy → claude code → cleanup.
 */

import { spawn, execFileSync } from 'node:child_process';
import { loadConfig, interactiveSetup, selectModel } from './config.js';
import { startProxy } from './proxy.js';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { debug: false, model: false, setup: false, help: false, provider: null, claudeArgs: [] };
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--debug') { opts.debug = true; i++; }
    else if (args[i] === '--setup') { opts.setup = true; i++; }
    else if (args[i] === '--help' || args[i] === '-h') { opts.help = true; i++; }
    else if (args[i] === '--model') { opts.model = true; i++; }
    else if (args[i] === '--provider') { opts.provider = args[i + 1] || null; i += 2; }
    else if (args[i] === '--') { opts.claudeArgs = args.slice(i + 1); break; }
    else { opts.claudeArgs = args.slice(i); break; }
  }
  return opts;
}

function printHelp() {
  console.error(`
  le-claude - Use Claude Code with Albert or ILaaS

  Usage:
    npx le-claude [options] [-- claude-args...]

  Options:
    --provider <name>   Use a specific provider (albert or ilaas)
    --setup             Configure a provider (API key and/or default model)
    --model             Choose which model to use for this session
    --debug             Enable proxy debug logging
    -h, --help          Show this help message

  Examples:
    npx le-claude                          Start with default or selected provider
    npx le-claude --provider albert        Use Albert for this session
    npx le-claude --provider ilaas         Use ILaaS for this session
    npx le-claude --setup                  Configure a provider
    npx le-claude --setup --provider ilaas Configure ILaaS provider
    npx le-claude --debug                  Start with debug logging
    npx le-claude -- -p "Fix the bug"      Pass arguments to Claude Code

  Configuration is stored in ~/.config/le-claude/config.json
  `);
}

// ---------------------------------------------------------------------------
// Claude Code launcher
// ---------------------------------------------------------------------------

function findClaude() {
  try {
    execFileSync('which', ['claude'], { stdio: 'pipe' });
    return 'claude';
  } catch {
    return null;
  }
}

/** Interactively pick a provider when multiple are configured. Returns { name, cfg }. */
async function selectProvider(config) {
  const names = Object.keys(config.providers);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error('');
    console.error('  Available providers:');
    names.forEach((name, i) => console.error(`    ${i + 1}. ${name}`));
    console.error('');
    const choice = await new Promise(resolve => rl.question('  Select provider [1]: ', resolve));
    const idx = (parseInt(choice, 10) || 1) - 1;
    const name = names[Math.max(0, Math.min(idx, names.length - 1))];
    return { name, cfg: config.providers[name] };
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Load or create config
  let config = loadConfig();

  if (!config || opts.setup) {
    config = await interactiveSetup(config, opts.provider);
  }

  // Resolve provider config
  let providerName;
  let providerCfg;
  if (opts.provider) {
    if (!config.providers[opts.provider]) {
      console.error(`  Error: unknown provider "${opts.provider}". Run: le-claude --setup --provider ${opts.provider}`);
      process.exit(1);
    }
    providerName = opts.provider;
    providerCfg = config.providers[opts.provider];
  } else if (Object.keys(config.providers).length > 1) {
    ({ name: providerName, cfg: providerCfg } = await selectProvider(config));
  } else {
    providerName = config.defaultProvider;
    providerCfg = config.providers[providerName];
  }

  if (!providerCfg) {
    console.error('  Error: no provider configured. Run: le-claude --setup');
    process.exit(1);
  }

  // CLI overrides
  let model;
  if (opts.model) {
    try {
      model = await selectModel(providerCfg.baseUrl, providerCfg.apiKey);
    } catch (e) {
      console.error(`  Warning: failed to fetch models for --model flag: ${e.message}`);
      model = providerCfg.model;
    }
  } else {
    model = providerCfg.model;
  }

  // Check claude is installed
  const claudeBin = findClaude();
  if (!claudeBin) {
    console.error('  Error: "claude" command not found.');
    console.error('  Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code');
    console.error('');
    process.exit(1);
  }

  // Start proxy
  if (opts.debug) process.stderr.write('  Starting proxy... ');
  const { server, port } = await startProxy({
    port: 0,
    baseUrl: providerCfg.baseUrl,
    apiKey: providerCfg.apiKey,
    model,
    debug: opts.debug,
    braveApiKey: config.braveApiKey,
  });
  if (opts.debug) console.error(`ok (port ${port})`);

  const claudeEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: 'le-claude',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_CUSTOM_MODEL_OPTION: model,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: `${providerName} ${model}`,
  };

  const claudeArgs = ['--model', model, ...opts.claudeArgs];
  const claude = spawn(claudeBin, claudeArgs, {
    stdio: 'inherit',
    env: claudeEnv,
  });

  function cleanup() {
    server.close();
  }

  claude.on('exit', (code) => {
    cleanup();
    process.exit(code || 0);
  });

  claude.on('error', (err) => {
    console.error(`  Failed to start Claude Code: ${err.message}`);
    cleanup();
    process.exit(1);
  });

  process.on('SIGINT', () => {
    claude.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    claude.kill('SIGTERM');
    cleanup();
  });
}

main().catch(err => {
  console.error(`  Error: ${err.message}`);
  process.exit(1);
});
