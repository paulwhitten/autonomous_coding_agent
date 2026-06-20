// File watcher for real-time updates to the UI via WebSocket

import chokidar, { type FSWatcher } from 'chokidar';
import { broadcast } from './websocket.js';
import path from 'path';

let watcher: FSWatcher | null = null;

export function startFileWatcher(paths: string[]): void {
  if (watcher) {
    watcher.close();
  }

  watcher = chokidar.watch(paths, {
    ignoreInitial: true,
    depth: 3,
    ignored: /(^|[/\\])\../, // ignore dotfiles
  });

  watcher.on('add', (filePath: string) => {
    broadcast('file:added', { path: filePath, type: classifyPath(filePath) });
  });

  watcher.on('change', (filePath: string) => {
    broadcast('file:changed', { path: filePath, type: classifyPath(filePath) });
  });

  watcher.on('unlink', (filePath: string) => {
    broadcast('file:removed', { path: filePath, type: classifyPath(filePath) });
  });

  console.log(`[watcher] Watching ${paths.length} paths for changes`);
}

export function stopFileWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

function classifyPath(filePath: string): string {
  const base = path.basename(filePath);
  if (base.endsWith('.workflow.json')) return 'workflow';
  if (base === 'team.json') return 'team';
  if (base === 'config.json') return 'config';
  if (filePath.includes('mailbox')) return 'mailbox';
  if (filePath.includes('logs')) return 'log';
  if (filePath.includes('tasks')) return 'task';
  return 'other';
}
