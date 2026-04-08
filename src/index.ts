// Main entry point for the autonomous agent

import { AutonomousAgent } from './agent.js';
import { AgentConfig } from './types.js';
import { validateWorkspaceStructure, validateGitCloneSeparation } from './workspace-validator.js';
import { isRateLimitError, parseRateLimitDelay } from './session-manager.js';
import { applyDefaults, sanitizeConfigForLogging, computeConfigOverrides, DeepPartial } from './config-defaults.js';
import { validateConfig } from './config-validator.js';
import { printError, formatConfigErrors } from './cli-output.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { initializeLogger, logger } from './logger.js';

// Load configuration with convention-over-configuration defaults
async function loadConfig(): Promise<AgentConfig> {
  const configPath = path.resolve(process.argv[2] || 'config.json');
  
  // Use console for initial loading (before logger is configured)
  process.stdout.write(`Loading config from: ${configPath}\n\n`);

  if (!existsSync(configPath)) {
    printError('Configuration Not Found', [
      `  File:    ${configPath}`,
      '',
      '  Run "npm run init" to create a config.json with sensible defaults,',
      '  or create one manually with just two fields:',
      '',
      '    { "agent": { "role": "developer" },',
      '      "mailbox": { "repoPath": "./mailbox" } }',
    ].join('\n'));
    process.exit(1);
  }
  
  try {
    const configData = await readFile(configPath, 'utf-8');
    const userConfig: DeepPartial<AgentConfig> = JSON.parse(configData);
    
    // Validate against JSON Schema before applying defaults
    const validation = await validateConfig(userConfig as Record<string, unknown>);
    if (!validation.valid) {
      printError(
        'Configuration Error',
        formatConfigErrors(validation.errors),
      );
      process.exit(1);
    }
    
    // Apply convention-over-configuration defaults
    const config = applyDefaults(userConfig);
    
    return config;
  } catch (error) {
    if (error instanceof SyntaxError) {
      printError('Invalid JSON in config.json', [
        `  ${error.message}`,
        '',
        '  Validate syntax: node -e "JSON.parse(require(\'fs\').readFileSync(\'config.json\'))"',
      ].join('\n'));
    } else if (error instanceof Error && error.message.startsWith('Config error:')) {
      printError('Configuration Error', `  ${error.message}`);
    } else {
      printError('Failed to Load Config', `  ${error}`);
    }
    process.exit(1);
  }
}

// Main function
(async () => {
  try {
    const config = await loadConfig();
    
    // Initialize logger with config
    initializeLogger(config.logging.path);
    
    // Log effective configuration (convention-over-configuration: show what is in effect)
    logger.info(
      { overrides: computeConfigOverrides(config) },
      'Configuration loaded (user overrides from defaults)',
    );
    logger.debug(
      { effectiveConfig: sanitizeConfigForLogging(config) },
      'Full effective configuration (defaults merged with user overrides)',
    );
    
    // Validate and initialize workspace structure
    logger.info('Validating workspace structure...');
    const workspaceStructure = await validateWorkspaceStructure(config.workspace.path);
    await validateGitCloneSeparation(workspaceStructure);
    
    // Display startup banner
    logger.info('Autonomous Copilot Agent');
    logger.info('================================');
    logger.info(`Agent ID: ${config.agent.hostname}_${config.agent.role}`);
    logger.info(`Mailbox: ${config.mailbox.repoPath}`);
    logger.info(`Git Sync: ${config.mailbox.gitSync ? 'enabled' : 'disabled'}`);
    logger.info(`Auto-commit: ${config.mailbox.autoCommit ? 'enabled' : 'disabled'}`);
    logger.info(`Broadcast: ${config.mailbox.supportBroadcast ? 'enabled' : 'disabled'}`);
    logger.info(`Attachments: ${config.mailbox.supportAttachments ? 'enabled' : 'disabled'}`);
    logger.info(`Check Interval: ${config.agent.checkIntervalMs / 1000}s`);
    logger.info(`Model: ${config.copilot.model}`);
    if (config.manager) {
      logger.info(`Manager: ${config.manager.hostname}_${config.manager.role}`);
    } else {
      logger.info('Manager: none (this agent is the manager)');
    }
    logger.info('================================');
    
    // Create and start the agent (pass config path for hot-reload watcher)
    const configPath = path.resolve(process.argv[2] || 'config.json');
    const agent = new AutonomousAgent(config, configPath);
    
    let isShuttingDown = false;
    let shutdownTimeout: NodeJS.Timeout | null = null;
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error: Error) => {
      logger.fatal({ err: error }, 'Uncaught exception');
      process.exit(1);
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason: any) => {
      const msg = String(reason?.message ?? reason ?? '');
      // Rate-limit errors can surface as unhandled rejections from the
      // Copilot SDK's internal streaming pipeline even when the caller's
      // try/catch already handled the error.  Do NOT crash -- log and
      // let the agent's backoff logic handle it.
      if (isRateLimitError(msg)) {
        const delayMs = parseRateLimitDelay(msg);
        logger.error(
          {
            delayMs,
            delayMin: Math.ceil(delayMs / 60_000),
            resumeAt: new Date(Date.now() + delayMs).toISOString(),
            rawMessage: msg.substring(0, 200),
          },
          'RATE LIMIT (unhandled rejection, non-fatal) -- agent backoff will handle',
        );
        return;
      }
      logger.fatal({ err: reason }, 'Unhandled promise rejection');
      process.exit(1);
    });
    
    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      if (isShuttingDown) {
        process.exit(0);
      }
      
      isShuttingDown = true;
      
      try {
        await agent.stop();
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      }
    };
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Initialize and start
    await agent.initialize();
    await agent.start();
    
    // If start() returns (agent stopped normally), exit cleanly
    logger.info('Agent stopped normally');
    process.exit(0);
    
  } catch (error) {
    logger.error({ err: error }, 'Fatal error');
    process.exit(1);
  }
})();
