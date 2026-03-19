/**
 * Structured logging with Pino
 * 
 * Provides consistent logging across all components with:
 * - Structured JSON output for production
 * - Pretty-printed output for development
 * - Child loggers for component-specific context
 * - Typed error context
 */

import pino from 'pino';
import { resolve } from 'path';

export interface ErrorContext {
  workItem?: string;
  messageSeq?: string;
  sequence?: number;
  attempt?: number;
  component?: string;
  operation?: string;
  [key: string]: any;
}

/**
 * Create base logger instance
 *
 * When NODE_ENV is 'test', returns a silent logger with no transport workers
 * so Pino's thread-stream threads do not leak into Jest's process pool.
 */
export function createLogger(logFilePath?: string): pino.Logger {
  // Test environment: silent, no transport workers.
  // JEST_WORKER_ID is always set by Jest in worker processes.
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
    return pino({ level: 'silent' });
  }

  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  // Development: Pretty console output
  if (isDevelopment && !logFilePath) {
    return pino({
      level: process.env.LOG_LEVEL || 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      },
    });
  }
  
  // Production or file logging: JSON output
  if (logFilePath) {
    return pino({
      level: process.env.LOG_LEVEL || 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        targets: [
          // Console output with pino-pretty
          {
            target: 'pino-pretty',
            level: 'info',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
              singleLine: false,
            },
          },
          // File output with JSON
          {
            target: 'pino/file',
            level: 'debug',
            options: {
              destination: resolve(logFilePath),
              mkdir: true,
            },
          },
        ],
      },
    });
  }
  
  // Fallback: JSON to stdout
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Create a child logger with component context
 */
export function createComponentLogger(
  baseLogger: pino.Logger,
  component: string,
  additionalContext?: Record<string, any>
): pino.Logger {
  return baseLogger.child({
    component,
    ...additionalContext,
  });
}

/**
 * Default logger instance (can be overridden)
 */
export let logger = createLogger();

/**
 * Initialize logger with configuration
 */
export function initializeLogger(logFilePath?: string): pino.Logger {
  logger = createLogger(logFilePath);
  return logger;
}

/**
 * Helper to create error log with context
 */
export function logError(
  logger: pino.Logger,
  error: Error,
  message: string,
  context?: ErrorContext
): void {
  logger.error({
    err: {
      message: error.message,
      stack: error.stack,
      name: error.name,
    },
    ...context,
  }, message);
}

/**
 * Helper to create warning log with context
 */
export function logWarning(
  logger: pino.Logger,
  message: string,
  context?: ErrorContext
): void {
  logger.warn(context || {}, message);
}

/**
 * Helper to create info log with context
 */
export function logInfo(
  logger: pino.Logger,
  message: string,
  context?: Record<string, any>
): void {
  logger.info(context || {}, message);
}
