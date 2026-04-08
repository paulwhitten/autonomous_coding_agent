// CLI output helpers for consistent, user-friendly terminal messages.
//
// Detects TTY to enable/disable ANSI color codes.
// All output goes to stderr (errors/warnings) or stdout (info/success).

const isTTY = process.stderr.isTTY ?? false;

const RESET = isTTY ? '\x1b[0m' : '';
const RED = isTTY ? '\x1b[31m' : '';
const YELLOW = isTTY ? '\x1b[33m' : '';
const GREEN = isTTY ? '\x1b[32m' : '';
const BOLD = isTTY ? '\x1b[1m' : '';
const DIM = isTTY ? '\x1b[2m' : '';

export function printError(heading: string, details: string): void {
  process.stderr.write(`\n${RED}${BOLD}${heading}${RESET}\n`);
  process.stderr.write(`${'='.repeat(heading.length)}\n`);
  process.stderr.write(`${details}\n\n`);
}

export function printWarning(message: string): void {
  process.stderr.write(`${YELLOW}WARNING:${RESET} ${message}\n`);
}

export function printSuccess(message: string): void {
  process.stdout.write(`${GREEN}${message}${RESET}\n`);
}

export function printDim(message: string): void {
  process.stdout.write(`${DIM}${message}${RESET}\n`);
}

/**
 * Format a config validation failure into a structured, actionable
 * error block for the terminal.
 */
export interface FieldError {
  path: string;
  message: string;
  value?: unknown;
}

export function formatConfigErrors(errors: FieldError[]): string {
  // Sort: missing required first, then type errors, then unknown properties
  const sorted = [...errors].sort((a, b) => {
    const rank = (e: FieldError): number => {
      if (e.message.includes('required')) return 0;
      if (e.message.includes('type')) return 1;
      return 2;
    };
    return rank(a) - rank(b);
  });

  const MAX_DISPLAY = 5;
  const shown = sorted.slice(0, MAX_DISPLAY);
  const remaining = sorted.length - MAX_DISPLAY;

  const lines: string[] = [];
  for (const err of shown) {
    lines.push(`  Field:   ${err.path}`);
    lines.push(`  Problem: ${err.message}`);
    if (err.value !== undefined) {
      lines.push(`  Value:   ${JSON.stringify(err.value)}`);
    }
    lines.push('');
  }

  if (remaining > 0) {
    lines.push(`  ... and ${remaining} more error(s). Fix the above first.\n`);
  }

  lines.push('  Tip: Only "agent.role" and "mailbox.repoPath" are required.');
  lines.push('  Run "npm run init" to scaffold a valid config.\n');

  return lines.join('\n');
}
