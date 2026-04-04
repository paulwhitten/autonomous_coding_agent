// Tests for utils.ts - Atomic writes and corruption recovery

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { loadJSON, saveJSON } from '../utils.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

describe('utils - JSON operations with atomic writes', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(async () => {
    // Create temporary directory for tests
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
    testFile = path.join(testDir, 'test.json');
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('saveJSON - atomic writes', () => {
    it('should write JSON file successfully', async () => {
      const data = { test: 'data', count: 42 };
      
      await saveJSON(testFile, data);
      
      const content = await fs.readFile(testFile, 'utf-8');
      const loaded = JSON.parse(content);
      expect(loaded).toEqual(data);
    });

    it('should create backup of existing file', async () => {
      const data1 = { version: 1 };
      const data2 = { version: 2 };
      
      await saveJSON(testFile, data1);
      await saveJSON(testFile, data2);
      
      const backupFile = `${testFile}.backup`;
      const backupExists = await fs.stat(backupFile).then(() => true).catch(() => false);
      expect(backupExists).toBe(true);
      
      const backupContent = await fs.readFile(backupFile, 'utf-8');
      const backupData = JSON.parse(backupContent);
      expect(backupData).toEqual(data1);
      
      const mainContent = await fs.readFile(testFile, 'utf-8');
      const mainData = JSON.parse(mainContent);
      expect(mainData).toEqual(data2);
    });

    it('should not leave temp file after successful write', async () => {
      await saveJSON(testFile, { data: 'test' });
      
      const tempFile = `${testFile}.tmp`;
      const tempExists = await fs.stat(tempFile).then(() => true).catch(() => false);
      expect(tempExists).toBe(false);
    });

    it('should handle nested objects', async () => {
      const complexData = {
        user: { name: 'test', age: 30 },
        items: [1, 2, 3],
        metadata: { created: new Date().toISOString() }
      };
      
      await saveJSON(testFile, complexData);
      
      const loaded = await loadJSON(testFile, {});
      expect(loaded).toEqual(complexData);
    });
  });

  describe('loadJSON - with defaults', () => {
    it('should load existing JSON file', async () => {
      const data = { test: 'value', number: 123 };
      await fs.writeFile(testFile, JSON.stringify(data), 'utf-8');
      
      const loaded = await loadJSON(testFile, {});
      expect(loaded).toEqual(data);
    });

    it('should return default value if file does not exist', async () => {
      const defaultValue = { default: true };
      
      const loaded = await loadJSON(testFile, defaultValue);
      expect(loaded).toEqual(defaultValue);
    });

    it('should return default value if file is empty', async () => {
      await fs.writeFile(testFile, '', 'utf-8');
      const defaultValue = { empty: true };
      
      const loaded = await loadJSON(testFile, defaultValue);
      expect(loaded).toEqual(defaultValue);
    });
  });

  describe('loadJSON - corruption recovery', () => {
    it('should recover from corrupted main file using backup', async () => {
      const goodData = { status: 'good', value: 42 };
      
      // Create good backup
      await fs.writeFile(`${testFile}.backup`, JSON.stringify(goodData), 'utf-8');
      
      // Corrupt main file
      await fs.writeFile(testFile, '{invalid json', 'utf-8');
      
      const loaded = await loadJSON(testFile, { fallback: true });
      expect(loaded).toEqual(goodData);
    });

    it('should restore backup to main file after recovery', async () => {
      const goodData = { recovered: true };
      
      await fs.writeFile(`${testFile}.backup`, JSON.stringify(goodData), 'utf-8');
      await fs.writeFile(testFile, '{bad}', 'utf-8');
      
      await loadJSON(testFile, {});
      
      // Main file should now have good data
      const mainContent = await fs.readFile(testFile, 'utf-8');
      const mainData = JSON.parse(mainContent);
      expect(mainData).toEqual(goodData);
    });

    it('should use default value if both main and backup are corrupted', async () => {
      const defaultValue = { default: true };
      
      await fs.writeFile(testFile, '{invalid}', 'utf-8');
      await fs.writeFile(`${testFile}.backup`, '{also bad}', 'utf-8');
      
      const loaded = await loadJSON(testFile, defaultValue);
      expect(loaded).toEqual(defaultValue);
    });

    it('should use default value if main corrupted and no backup exists', async () => {
      const defaultValue = { no_backup: true };
      
      await fs.writeFile(testFile, 'not valid json', 'utf-8');
      
      const loaded = await loadJSON(testFile, defaultValue);
      expect(loaded).toEqual(defaultValue);
    });
  });

  describe('atomic write sequence', () => {
    it('should maintain data integrity during rapid writes', async () => {
      const writes = [
        { sequence: 1, data: 'first' },
        { sequence: 2, data: 'second' },
        { sequence: 3, data: 'third' }
      ];
      
      for (const write of writes) {
        await saveJSON(testFile, write);
      }
      
      const final = await loadJSON(testFile, {});
      expect(final).toEqual(writes[2]);
      
      // Backup should have second-to-last write
      const backup = await loadJSON(`${testFile}.backup`, {});
      expect(backup).toEqual(writes[1]);
    });

    it('should handle sequential rapid writes', async () => {
      const data1 = { write: 1 };
      const data2 = { write: 2 };
      const data3 = { write: 3 };
      
      // Sequential writes (simulates rapid updates)
      await saveJSON(testFile, data1);
      await saveJSON(testFile, data2);
      await saveJSON(testFile, data3);
      
      // Final should be last write
      const result = await loadJSON(testFile, {});
      expect(result).toEqual(data3);
      
      // Backup should have second-to-last
      const backup = await loadJSON(`${testFile}.backup`, {});
      expect(backup).toEqual(data2);
    });
  });
});
