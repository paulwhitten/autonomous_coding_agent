// Utility functions for the autonomous agent

import fs from 'fs/promises';
import path from 'path';
import { logger, logWarning, logError } from './logger.js';

/**
 * Format date as YYYY-MM-DD-HHMM for mailbox message filenames.
 * Uses UTC to match the seed script (date -u) so all filenames
 * share the same timezone and sort correctly.
 */
export function formatMailboxTimestamp(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  
  return `${year}-${month}-${day}-${hours}${minutes}`;
}

import { MessageType } from './types.js';

/**
 * Valid MessageType values used for runtime validation.
 */
const VALID_MESSAGE_TYPES: readonly string[] = ['workflow', 'oob', 'status', 'unstructured'];

/**
 * Parse mailbox message file.
 *
 * Format (v2 -- strict schema):
 * ```
 * Date: <ISO timestamp>
 * From: <agentId>
 * To: <agentId>
 * Subject: <text>
 * Priority: HIGH|NORMAL|LOW     (optional)
 * MessageType: workflow|oob|status|unstructured  (optional, defaults to unstructured)
 * ---
 * <body: JSON payload for workflow/oob, free text for unstructured>
 * ```
 *
 * Backward compatibility: files without MessageType are treated as
 * unstructured.  Files with MessageType workflow/oob whose body is
 * not valid JSON are downgraded to unstructured with a warning.
 */
export async function parseMailboxMessage(filepath: string): Promise<{
  date: string;
  from: string;
  to: string;
  subject: string;
  priority?: string;
  messageType: MessageType;
  content: string;
  payload?: Record<string, unknown>;
}> {
  const content = await fs.readFile(filepath, 'utf-8');
  const lines = content.split('\n');

  const metadata: Record<string, string> = {};
  let contentStart = 0;

  // Parse metadata headers (everything before the first '---' or blank line)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === '---' || line === '') {
      contentStart = i + 1;
      break;
    }

    // Match "Key: value" -- key is word chars, value is rest of line
    const match = line.match(/^([\w-]+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      metadata[key.toLowerCase()] = value.trim();
    }
  }

  // Get body after headers
  const body = lines.slice(contentStart).join('\n').trim();

  // Determine MessageType from header (default: unstructured)
  let messageType: MessageType = 'unstructured';
  const rawType = metadata.messagetype; // keys are lowercased
  if (rawType && VALID_MESSAGE_TYPES.includes(rawType)) {
    messageType = rawType as MessageType;
  }

  // For structured types, try to parse body as JSON
  let payload: Record<string, unknown> | undefined;
  if (messageType === 'workflow' || messageType === 'oob') {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        payload = parsed;
      } else {
        // Valid JSON but wrong shape -- downgrade
        messageType = 'unstructured';
      }
    } catch {
      // JSON parse failed -- downgrade to unstructured so message is
      // not silently discarded.  The agent will process it via LLM.
      messageType = 'unstructured';
    }
  }

  // Backward compatibility: detect legacy WORKFLOW_MSG markers in body
  // and promote to structured if MessageType was not set.
  if (messageType === 'unstructured' && !rawType && body.includes('<!-- WORKFLOW_MSG:')) {
    messageType = 'unstructured'; // Keep as-is -- legacy markers handled by old path
  }

  return {
    date: metadata.date || '',
    from: metadata.from || '',
    to: metadata.to || '',
    subject: metadata.subject || '',
    priority: metadata.priority,
    messageType,
    content: body,
    payload,
  };
}

/**
 * Create a mailbox message file.
 *
 * @param messageType  Strict message type written to the MessageType header.
 *                     Defaults to 'unstructured' for backward compatibility.
 * @param payload      For 'workflow' and 'oob' types: the structured object
 *                     to serialize as the message body.  Ignored for
 *                     'unstructured' (uses `content` as free text).
 */
export async function createMailboxMessage(
  mailboxPath: string,
  filename: string,
  from: string,
  to: string,
  subject: string,
  content: string,
  priority?: string,
  messageType?: MessageType,
  payload?: Record<string, unknown>,
): Promise<string> {
  const timestamp = new Date().toISOString();
  const resolvedType: MessageType = messageType ?? 'unstructured';

  // Build header block
  let header = `Date: ${timestamp}\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}`;
  if (priority) {
    header += `\nPriority: ${priority}`;
  }
  header += `\nMessageType: ${resolvedType}`;

  // Build body -- structured types use JSON, unstructured uses free text
  let body: string;
  if ((resolvedType === 'workflow' || resolvedType === 'oob') && payload) {
    body = JSON.stringify(payload, null, 2);
  } else {
    body = content;
  }

  const message = `${header}\n---\n\n${body}\n`;

  const filepath = path.join(mailboxPath, filename);
  await fs.writeFile(filepath, message, 'utf-8');

  return filepath;
}

/**
 * Sleep for specified milliseconds
 * Uses unref() to prevent keeping the process alive during tests
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref(); // Don't keep process alive for Jest
  });
}

/**
 * Load JSON file safely with corruption recovery
 */
export async function loadJSON<T>(filepath: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    
    // If file doesn't exist, just use default (not an error on first run)
    if (err.code === 'ENOENT') {
      return defaultValue;
    }
    
    // File exists but corrupted - try backup
    const backupPath = `${filepath}.backup`;
    try {
      logWarning(logger, 'Primary file corrupted, attempting backup', { filepath });
      const backupContent = await fs.readFile(backupPath, 'utf-8');
      const recovered = JSON.parse(backupContent);
      
      // Restore backup to main file
      await fs.copyFile(backupPath, filepath);
      logWarning(logger, 'Recovered from backup', { filepath });
      
      return recovered;
    } catch (backupError) {
      // Both failed, use default
      logError(logger, error as Error, 'Both primary and backup failed, using default', { filepath });
      return defaultValue;
    }
  }
}

/**
 * Save JSON file with atomic write and backup
 */
export async function saveJSON(filepath: string, data: any): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  const tempPath = `${filepath}.tmp`;
  const backupPath = `${filepath}.backup`;
  
  try {
    // Write to temporary file first
    await fs.writeFile(tempPath, content, 'utf-8');
    
    // Create backup of existing file (if exists)
    try {
      await fs.stat(filepath);
      await fs.copyFile(filepath, backupPath);
    } catch {
      // No existing file, that's okay
    }
    
    // Atomic rename (POSIX guarantees atomicity)
    await fs.rename(tempPath, filepath);
  } catch (error) {
    // Clean up temp file if something went wrong
    try {
      await fs.unlink(tempPath);
    } catch {}
    throw error;
  }
}

// Logger class removed - use pino logger from logger.ts
