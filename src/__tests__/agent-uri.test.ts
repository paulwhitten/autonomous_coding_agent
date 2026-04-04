// Tests for agent-uri.ts - Transport URI parsing

import { describe, it, expect } from '@jest/globals';
import { parseAgentUri, resolveTargetAddress } from '../agent-uri.js';

describe('parseAgentUri', () => {
  // ---------------------------------------------------------------
  // a2a:// scheme
  // ---------------------------------------------------------------
  describe('a2a:// scheme', () => {
    it('should parse a2a://host:port to HTTP URL', () => {
      const result = parseAgentUri('a2a://localhost:4000');
      expect(result).toEqual({ scheme: 'a2a', a2aUrl: 'http://localhost:4000' });
    });

    it('should parse a2a://host:port/path', () => {
      const result = parseAgentUri('a2a://example.com:8080/a2a/jsonrpc');
      expect(result).toEqual({ scheme: 'a2a', a2aUrl: 'http://example.com:8080/a2a/jsonrpc' });
    });

    it('should parse a2a://host without port', () => {
      const result = parseAgentUri('a2a://example.com');
      expect(result).toEqual({ scheme: 'a2a', a2aUrl: 'http://example.com' });
    });

    it('should handle a2a:// with no host', () => {
      const result = parseAgentUri('a2a://');
      expect(result).toEqual({ scheme: 'a2a' });
      expect(result.a2aUrl).toBeUndefined();
    });

    it('should trim whitespace around a2a URI', () => {
      const result = parseAgentUri('  a2a://localhost:3000  ');
      expect(result).toEqual({ scheme: 'a2a', a2aUrl: 'http://localhost:3000' });
    });
  });

  // ---------------------------------------------------------------
  // mailbox:// scheme
  // ---------------------------------------------------------------
  describe('mailbox:// scheme', () => {
    it('should parse mailbox://agent_id', () => {
      const result = parseAgentUri('mailbox://dev_developer');
      expect(result).toEqual({ scheme: 'mailbox' });
    });

    it('should parse bare mailbox://', () => {
      const result = parseAgentUri('mailbox://');
      expect(result).toEqual({ scheme: 'mailbox' });
    });

    it('should not include a2aUrl for mailbox scheme', () => {
      const result = parseAgentUri('mailbox://some-agent');
      expect(result.a2aUrl).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  // Absent / empty / null / undefined (backward compat default)
  // ---------------------------------------------------------------
  describe('backward-compatible defaults', () => {
    it('should default to mailbox for undefined', () => {
      const result = parseAgentUri(undefined);
      expect(result).toEqual({ scheme: 'mailbox' });
    });

    it('should default to mailbox for null', () => {
      const result = parseAgentUri(null);
      expect(result).toEqual({ scheme: 'mailbox' });
    });

    it('should default to mailbox for empty string', () => {
      const result = parseAgentUri('');
      expect(result).toEqual({ scheme: 'mailbox' });
    });

    it('should default to mailbox for whitespace-only string', () => {
      const result = parseAgentUri('   ');
      expect(result).toEqual({ scheme: 'mailbox' });
    });
  });

  // ---------------------------------------------------------------
  // Unknown schemes
  // ---------------------------------------------------------------
  describe('unknown schemes', () => {
    it('should default to mailbox for unknown scheme', () => {
      const result = parseAgentUri('http://example.com');
      expect(result).toEqual({ scheme: 'mailbox' });
    });

    it('should default to mailbox for plain text', () => {
      const result = parseAgentUri('just-some-text');
      expect(result).toEqual({ scheme: 'mailbox' });
    });
  });
});

describe('resolveTargetAddress', () => {
  const teamMembers = [
    { hostname: 'dev-1', role: 'developer' },
    { hostname: 'qa-1', role: 'qa', uri: 'a2a://qa-1:4000' },
  ];

  it('should return undefined when role is not in teamMembers', () => {
    expect(resolveTargetAddress('manager', teamMembers, null)).toBeUndefined();
  });

  it('should return undefined when teamMembers is undefined', () => {
    expect(resolveTargetAddress('developer', undefined, null)).toBeUndefined();
  });

  it('should return address with uri from teamMembers when present', () => {
    const result = resolveTargetAddress('qa', teamMembers, null);
    expect(result).toEqual({ hostname: 'qa-1', role: 'qa', uri: 'a2a://qa-1:4000' });
  });

  it('should enrich uri from roster when teamMembers entry lacks one', () => {
    const roster = [
      { role: 'developer', uri: 'a2a://dev-1:5000' },
    ];
    const result = resolveTargetAddress('developer', teamMembers, roster);
    expect(result).toEqual({ hostname: 'dev-1', role: 'developer', uri: 'a2a://dev-1:5000' });
  });

  it('should return address without uri when neither source has one', () => {
    const result = resolveTargetAddress('developer', teamMembers, []);
    expect(result).toEqual({ hostname: 'dev-1', role: 'developer', uri: undefined });
  });

  it('should prefer teamMembers uri over roster uri', () => {
    const roster = [
      { role: 'qa', uri: 'a2a://different:9999' },
    ];
    const result = resolveTargetAddress('qa', teamMembers, roster);
    expect(result).toEqual({ hostname: 'qa-1', role: 'qa', uri: 'a2a://qa-1:4000' });
  });

  it('should handle null roster', () => {
    const result = resolveTargetAddress('developer', teamMembers, null);
    expect(result).toEqual({ hostname: 'dev-1', role: 'developer', uri: undefined });
  });
});
