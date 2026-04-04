// Unit tests for Permission Handler

import {
  createPermissionHandler,
  DEFAULT_PERMISSIONS,
  DEFAULT_SHELL_ALLOWLIST,
  extractBaseCommand,
  PermissionsConfig,
  PermissionRequest,
  PermissionOverrides
} from '../permission-handler.js';
import pino from 'pino';
import { jest } from '@jest/globals';

describe('Permission Handler', () => {
  let mockLogger: pino.Logger;

  beforeEach(() => {
    mockLogger = pino({ level: 'silent' });
  });

  describe('DEFAULT_PERMISSIONS', () => {
    it('should use allowlist for shell and deny url/mcp', () => {
      expect(DEFAULT_PERMISSIONS).toEqual({
        shell: 'allowlist',
        write: 'allow',
        read: 'allow',
        url: 'deny',
        mcp: 'deny',
      });
    });
  });

  describe('DEFAULT_SHELL_ALLOWLIST', () => {
    it('should include common SCM tools', () => {
      expect(DEFAULT_SHELL_ALLOWLIST.has('git')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('gh')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('svn')).toBe(true);
    });

    it('should include Node.js toolchain', () => {
      expect(DEFAULT_SHELL_ALLOWLIST.has('node')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('npm')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('npx')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('yarn')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('pnpm')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('tsc')).toBe(true);
    });

    it('should include Python toolchain', () => {
      expect(DEFAULT_SHELL_ALLOWLIST.has('python')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('python3')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('pip')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('pip3')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('pytest')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('poetry')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('uv')).toBe(true);
    });

    it('should include Rust toolchain', () => {
      expect(DEFAULT_SHELL_ALLOWLIST.has('rustup')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('cargo')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('rustc')).toBe(true);
    });

    it('should include C/C++ toolchain', () => {
      expect(DEFAULT_SHELL_ALLOWLIST.has('gcc')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('g++')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('clang')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('make')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('cmake')).toBe(true);
    });

    it('should include common shell utilities', () => {
      expect(DEFAULT_SHELL_ALLOWLIST.has('ls')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('cat')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('grep')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('find')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('mkdir')).toBe(true);
    });

    it('should include process management tools', () => {
      expect(DEFAULT_SHELL_ALLOWLIST.has('ps')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('kill')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('killall')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('lsof')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('fuser')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('nohup')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('timeout')).toBe(true);
    });

    it('should include system inspection utilities', () => {
      expect(DEFAULT_SHELL_ALLOWLIST.has('uname')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('whoami')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('hostname')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('file')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('stat')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('tee')).toBe(true);
    });

    it('should include shell keywords for compound commands', () => {
      expect(DEFAULT_SHELL_ALLOWLIST.has('for')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('while')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('until')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('if')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('case')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('select')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('[')).toBe(true);
      expect(DEFAULT_SHELL_ALLOWLIST.has('[[')).toBe(true);
    });
  });

  describe('extractBaseCommand', () => {
    it('should extract simple command name', () => {
      expect(extractBaseCommand('git status')).toBe('git');
    });

    it('should strip absolute path', () => {
      expect(extractBaseCommand('/usr/bin/python3 script.py')).toBe('python3');
    });

    it('should handle command with no arguments', () => {
      expect(extractBaseCommand('ls')).toBe('ls');
    });

    it('should handle env prefix with var assignments', () => {
      expect(extractBaseCommand('env FOO=bar NODE_ENV=test npm test')).toBe('npm');
    });

    it('should handle env with path in command', () => {
      expect(extractBaseCommand('env HOME=/tmp /usr/bin/git init')).toBe('git');
    });

    it('should return env if no command follows', () => {
      expect(extractBaseCommand('env FOO=bar')).toBe('env');
    });

    it('should handle empty string', () => {
      expect(extractBaseCommand('')).toBe('');
    });

    it('should handle whitespace-only string', () => {
      expect(extractBaseCommand('   ')).toBe('');
    });

    it('should handle leading whitespace', () => {
      expect(extractBaseCommand('  git push')).toBe('git');
    });

    it('should extract shell keywords from compound commands', () => {
      expect(extractBaseCommand('for i in {1..10}; do echo $i; done')).toBe('for');
      expect(extractBaseCommand('while true; do sleep 1; done')).toBe('while');
      expect(extractBaseCommand('if [ -f foo.txt ]; then cat foo.txt; fi')).toBe('if');
    });
  });

  describe('createPermissionHandler', () => {
    it('should return a function', () => {
      const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', mockLogger);
      expect(typeof handler).toBe('function');
    });

    describe('allow policy', () => {
      const config: PermissionsConfig = {
        shell: 'allow',
        write: 'allow',
        read: 'allow',
        url: 'allow',
        mcp: 'allow',
      };

      it('should approve shell requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'git init' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve write requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'write', path: '/some/file.ts' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve read requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'read', path: '/some/file.ts' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve url requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'url', url: 'https://example.com' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve mcp requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'mcp' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });
    });

    describe('deny policy', () => {
      const config: PermissionsConfig = {
        shell: 'deny',
        write: 'deny',
        read: 'deny',
        url: 'deny',
        mcp: 'deny',
      };

      it('should deny shell requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'rm -rf /' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should deny write requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'write', path: '/etc/passwd' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should deny read requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'read', path: '/etc/shadow' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should deny url requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'url' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should deny mcp requests', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'mcp' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });
    });

    describe('allowlist policy (shell)', () => {
      const config: PermissionsConfig = {
        shell: 'allowlist',
        write: 'allow',
        read: 'allow',
        url: 'deny',
        mcp: 'deny',
      };

      it('should approve allowlisted commands: git', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'git init' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve allowlisted commands: npm', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'npm install express' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve allowlisted commands: python3', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'python3 -m pytest tests/' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve allowlisted commands: cargo', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'cargo build --release' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve allowlisted commands: gcc', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'gcc -o main main.c' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve allowlisted commands: g++', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'g++ -std=c++17 -o app main.cpp' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve allowlisted commands: make', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'make all' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve commands with absolute paths', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: '/usr/bin/python3 setup.py' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should deny commands not in allowlist', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'sudo rm -rf /' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should deny unknown/dangerous commands', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', command: 'nc -l 4444' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should approve when no command info is available', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell' },  // No command property
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should handle args array without command property', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          { kind: 'shell', args: ['npm', 'test'] },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });
    });

    describe('SDK request shape (fullCommandText / commands array)', () => {
      const config: PermissionsConfig = {
        shell: 'allowlist',
        write: 'allow',
        read: 'allow',
        url: 'deny',
        mcp: 'deny',
      };

      it('should extract command from fullCommandText (primary SDK field)', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          {
            kind: 'shell',
            fullCommandText: 'npm test',
            commands: [{ identifier: 'npm test', readOnly: false }],
          },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should deny dangerous command via fullCommandText', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          {
            kind: 'shell',
            fullCommandText: 'sudo rm -rf /',
            commands: [{ identifier: 'sudo rm -rf /', readOnly: false }],
          },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should extract from commands[0].identifier when fullCommandText absent', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          {
            kind: 'shell',
            commands: [{ identifier: 'git status', readOnly: true }],
          },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should deny via commands[0].identifier when not in allowlist', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          {
            kind: 'shell',
            commands: [{ identifier: 'nc -l 4444', readOnly: false }],
          },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should handle real SDK shape with all metadata fields', () => {
        // Exact shape from the debug log
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          {
            kind: 'shell',
            toolCallId: 'call_5pZgmd4N0iztcigC296MSNGb',
            fullCommandText: 'npm test',
            intention: 'Run all unit tests for the TypeScript file',
            commands: [
              { identifier: 'npm test', readOnly: false }
            ],
            possiblePaths: [],
            possibleUrls: [],
            hasWriteFileRedirection: false,
            canOfferSessionApproval: false,
          },
          { sessionId: '9aa61606-d3ac-40ce-8e92-c378a8208422' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should handle fullCommandText with absolute path', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        const result = handler(
          {
            kind: 'shell',
            fullCommandText: '/usr/local/bin/npm test',
            commands: [{ identifier: '/usr/local/bin/npm test', readOnly: false }],
          },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should prefer fullCommandText over commands array', () => {
        const handler = createPermissionHandler(config, '/workspace', mockLogger);
        // fullCommandText is safe, but commands[0].identifier would be dangerous
        const result = handler(
          {
            kind: 'shell',
            fullCommandText: 'git status',
            commands: [{ identifier: 'sudo rm -rf /', readOnly: false }],
          },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });
    });

    describe('shellAllowAdditional', () => {
      it('should allow additional commands from config', () => {
        const config: PermissionsConfig = {
          shell: 'allowlist',
          write: 'allow',
          read: 'allow',
          url: 'deny',
          mcp: 'deny',
          shellAllowAdditional: ['mycustomtool', 'terraform'],
        };
        const handler = createPermissionHandler(config, '/workspace', mockLogger);

        expect(handler(
          { kind: 'shell', command: 'mycustomtool deploy' },
          { sessionId: 's1' }
        ).kind).toBe('approved');

        expect(handler(
          { kind: 'shell', command: 'terraform plan' },
          { sessionId: 's1' }
        ).kind).toBe('approved');
      });

      it('should still allow default commands when additional are specified', () => {
        const config: PermissionsConfig = {
          shell: 'allowlist',
          write: 'allow',
          read: 'allow',
          url: 'deny',
          mcp: 'deny',
          shellAllowAdditional: ['mycustomtool'],
        };
        const handler = createPermissionHandler(config, '/workspace', mockLogger);

        expect(handler(
          { kind: 'shell', command: 'git status' },
          { sessionId: 's1' }
        ).kind).toBe('approved');
      });

      it('should still deny unknown commands with additional configured', () => {
        const config: PermissionsConfig = {
          shell: 'allowlist',
          write: 'allow',
          read: 'allow',
          url: 'deny',
          mcp: 'deny',
          shellAllowAdditional: ['mycustomtool'],
        };
        const handler = createPermissionHandler(config, '/workspace', mockLogger);

        expect(handler(
          { kind: 'shell', command: 'sudo reboot' },
          { sessionId: 's1' }
        ).kind).toBe('denied-by-rules');
      });
    });

    describe('workingDir policy', () => {
      const workingDir = '/home/user/workspace';
      const config: PermissionsConfig = {
        shell: 'allow',
        write: 'workingDir',
        read: 'workingDir',
        url: 'deny',
        mcp: 'deny',
      };

      it('should approve writes within working directory', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'write', path: '/home/user/workspace/src/main.ts' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should approve writes to the working directory itself', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'write', path: '/home/user/workspace' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should deny writes outside working directory', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'write', path: '/etc/passwd' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should deny writes to parent directory', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'write', path: '/home/user' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should deny writes to sibling directory', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'write', path: '/home/user/workspace-other/file.ts' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should approve reads within working directory', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'read', path: '/home/user/workspace/package.json' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should deny reads outside working directory', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'read', path: '/root/.ssh/id_rsa' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });

      it('should approve when request has no path', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'write' },  // No path property
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should recognize filePath property', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'write', filePath: '/home/user/workspace/test.ts' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should recognize uri property', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'read', uri: '/home/user/workspace/data.json' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });

      it('should recognize file property', () => {
        const handler = createPermissionHandler(config, workingDir, mockLogger);
        const result = handler(
          { kind: 'read', file: '/home/user/workspace/README.md' },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('approved');
      });
    });

    describe('default permissions (allowlist + mixed)', () => {
      it('should use DEFAULT_PERMISSIONS correctly', () => {
        const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', mockLogger);

        // shell (allowlist): approve known commands
        expect(handler({ kind: 'shell', command: 'git status' }, { sessionId: 's1' }).kind).toBe('approved');
        expect(handler({ kind: 'shell', command: 'npm test' }, { sessionId: 's1' }).kind).toBe('approved');
        // shell (allowlist): deny unknown commands
        expect(handler({ kind: 'shell', command: 'sudo reboot' }, { sessionId: 's1' }).kind).toBe('denied-by-rules');
        // write: allow
        expect(handler({ kind: 'write', path: '/any/path' }, { sessionId: 's1' }).kind).toBe('approved');
        // read: allow
        expect(handler({ kind: 'read', path: '/any/path' }, { sessionId: 's1' }).kind).toBe('approved');
        // url: deny
        expect(handler({ kind: 'url' }, { sessionId: 's1' }).kind).toBe('denied-by-rules');
        // mcp: deny
        expect(handler({ kind: 'mcp' }, { sessionId: 's1' }).kind).toBe('denied-by-rules');
      });
    });

    describe('unknown permission kind', () => {
      it('should deny unknown kinds', () => {
        const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', mockLogger);
        const result = handler(
          { kind: 'unknown-kind' as any },
          { sessionId: 'test-session' }
        );
        expect(result.kind).toBe('denied-by-rules');
      });
    });

    describe('logging', () => {
      it('should log every permission request at info level', () => {
        const logEntries: any[] = [];
        const spyLogger = pino({
          level: 'info',
          transport: undefined,
        });
        // Use a real logger but spy on the info method
        const infoSpy = jest.spyOn(spyLogger, 'info');
        
        const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', spyLogger);
        handler({ kind: 'shell', command: 'git status' }, { sessionId: 'test-session' });

        // Should be called at least once for the audit log, plus the decision
        expect(infoSpy).toHaveBeenCalled();
        infoSpy.mockRestore();
      });

      it('should log denied commands with warn level', () => {
        const spyLogger = pino({ level: 'warn' });
        const warnSpy = jest.spyOn(spyLogger, 'warn');
        
        const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', spyLogger);
        handler({ kind: 'shell', command: 'sudo rm -rf /' }, { sessionId: 'test-session' });

        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
      });
    });

    describe('config merging', () => {
      it('should support overriding shell to allow-all', () => {
        const merged: PermissionsConfig = {
          ...DEFAULT_PERMISSIONS,
          shell: 'allow',
        };
        const handler = createPermissionHandler(merged, '/workspace', mockLogger);

        // Even unknown commands approved with 'allow' policy
        expect(handler({ kind: 'shell', command: 'sudo reboot' }, { sessionId: 's1' }).kind).toBe('approved');
      });

      it('should support restricting to workingDir', () => {
        const locked: PermissionsConfig = {
          shell: 'allowlist',
          write: 'workingDir',
          read: 'workingDir',
          url: 'deny',
          mcp: 'deny',
        };
        const handler = createPermissionHandler(locked, '/workspace', mockLogger);

        expect(handler({ kind: 'shell', command: 'git status' }, { sessionId: 's1' }).kind).toBe('approved');
        expect(handler({ kind: 'write', path: '/workspace/file.ts' }, { sessionId: 's1' }).kind).toBe('approved');
        expect(handler({ kind: 'write', path: '/etc/hosts' }, { sessionId: 's1' }).kind).toBe('denied-by-rules');
        expect(handler({ kind: 'read', path: '/workspace/file.ts' }, { sessionId: 's1' }).kind).toBe('approved');
        expect(handler({ kind: 'read', path: '/etc/hosts' }, { sessionId: 's1' }).kind).toBe('denied-by-rules');
      });
    });
  });

  describe('PermissionOverrides (workflow-driven)', () => {
    it('should deny writes when override sets write to deny', () => {
      const overrides: PermissionOverrides = { write: 'deny' };
      const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', mockLogger, overrides);

      // write should be denied
      const result = handler(
        { kind: 'write', path: '/workspace/file.ts' },
        { sessionId: 'test-session' }
      );
      expect(result.kind).toBe('denied-by-rules');

      // read should still be allowed (no override)
      const readResult = handler(
        { kind: 'read', path: '/workspace/file.ts' },
        { sessionId: 'test-session' }
      );
      expect(readResult.kind).toBe('approved');
    });

    it('should allow writes when override is cleared', () => {
      const overrides: PermissionOverrides = { write: 'deny' };
      const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', mockLogger, overrides);

      // Denied while override active
      expect(handler(
        { kind: 'write', path: '/workspace/file.ts' },
        { sessionId: 's1' }
      ).kind).toBe('denied-by-rules');

      // Clear override (simulates state exit)
      delete overrides.write;

      // Should be allowed again
      expect(handler(
        { kind: 'write', path: '/workspace/file.ts' },
        { sessionId: 's1' }
      ).kind).toBe('approved');
    });

    it('should override takes precedence over base config', () => {
      // Base config denies writes, override allows them
      const config: PermissionsConfig = { ...DEFAULT_PERMISSIONS, write: 'deny' };
      const overrides: PermissionOverrides = { write: 'allow' };
      const handler = createPermissionHandler(config, '/workspace', mockLogger, overrides);

      expect(handler(
        { kind: 'write', path: '/workspace/file.ts' },
        { sessionId: 's1' }
      ).kind).toBe('approved');
    });

    it('should support mutating overrides between requests', () => {
      const overrides: PermissionOverrides = {};
      const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', mockLogger, overrides);

      // Initially no override — writes allowed
      expect(handler(
        { kind: 'write', path: '/workspace/file.ts' },
        { sessionId: 's1' }
      ).kind).toBe('approved');

      // Apply override (simulates state entry)
      overrides.write = 'deny';
      expect(handler(
        { kind: 'write', path: '/workspace/file.ts' },
        { sessionId: 's1' }
      ).kind).toBe('denied-by-rules');

      // Clear override (simulates state exit)
      delete overrides.write;
      expect(handler(
        { kind: 'write', path: '/workspace/file.ts' },
        { sessionId: 's1' }
      ).kind).toBe('approved');
    });

    it('should not affect shell allowlist behavior when no shell override', () => {
      const overrides: PermissionOverrides = { write: 'deny' };
      const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', mockLogger, overrides);

      // Shell should still use allowlist (no shell override)
      expect(handler(
        { kind: 'shell', command: 'cargo test' },
        { sessionId: 's1' }
      ).kind).toBe('approved');

      expect(handler(
        { kind: 'shell', command: 'dangerous-command' },
        { sessionId: 's1' }
      ).kind).toBe('denied-by-rules');
    });

    it('should deny shell commands when shell override set to deny', () => {
      const overrides: PermissionOverrides = { shell: 'deny' };
      const handler = createPermissionHandler(DEFAULT_PERMISSIONS, '/workspace', mockLogger, overrides);

      expect(handler(
        { kind: 'shell', command: 'cargo test' },
        { sessionId: 's1' }
      ).kind).toBe('denied-by-rules');
    });
  });
});
