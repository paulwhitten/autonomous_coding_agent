// Shared config loader for CLI scripts.
// Reads config.json, validates, applies defaults, and returns the effective config.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { AgentConfig } from '../../src/types.js';
import { applyDefaults, DeepPartial } from '../../src/config-defaults.js';
import { printError } from '../../src/cli-output.js';

export async function loadEffectiveConfig(configPathArg?: string): Promise<AgentConfig> {
  const configPath = path.resolve(configPathArg || 'config.json');

  if (!existsSync(configPath)) {
    printError('Configuration Not Found', [
      `  File: ${configPath}`,
      '',
      '  Run "npm run init" to create config.json.',
    ].join('\n'));
    process.exit(1);
  }

  const raw = await readFile(configPath, 'utf-8');
  const userConfig: DeepPartial<AgentConfig> = JSON.parse(raw);
  return applyDefaults(userConfig);
}
