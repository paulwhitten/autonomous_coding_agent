// Script to generate .github/copilot-instructions.md

import { generateCopilotInstructions } from '../src/generate-instructions.js';
import { readFile } from 'fs/promises';
import path from 'path';

const configPath = path.resolve(process.argv[2] || 'config.json');

console.log('📄 Generating .github/copilot-instructions.md');
console.log(`Config: ${configPath}\n`);

try {
  const configData = await readFile(configPath, 'utf-8');
  const config = JSON.parse(configData);
  
  // Auto-detect hostname if needed
  if (config.agent.hostname === 'auto-detect') {
    const os = await import('os');
    config.agent.hostname = os.hostname();
  }
  
  const workspaceRoot = path.resolve(
    config.workspace?.path || '.',
    config.workspace?.workingFolder || 'project',
  );
  await generateCopilotInstructions(config, workspaceRoot);
  
  console.log('\n✅ Successfully generated .github/copilot-instructions.md');
  console.log('   This file tells Copilot about your agent role and responsibilities.');
  
} catch (error) {
  console.error('❌ Failed to generate instructions:', error);
  process.exit(1);
}
