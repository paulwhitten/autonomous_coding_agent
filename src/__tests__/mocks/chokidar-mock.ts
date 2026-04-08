// Lightweight mock for chokidar so Jest can load file-watcher.ts
const watcher = {
  on: function () { return watcher; },
  close: () => Promise.resolve(),
};

export default {
  watch: () => watcher,
};

export type FSWatcher = typeof watcher;
