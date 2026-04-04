// Test helper utilities

import pino from 'pino';

/**
 * Create a no-op logger for testing
 */
export function createMockLogger(): pino.Logger {
  // Create a pino logger that outputs nothing
  return pino({
    level: 'silent',  // Disable all logging
  });
}

