// Tests for prompt-templates.ts - Unified work item prompt

import { describe, it, expect } from '@jest/globals';
import { buildWorkItemPrompt } from '../prompt-templates.js';

describe('Prompt Templates', () => {
  const workItem = {
    sequence: 42,
    title: 'Test Work Item',
    content: 'This is a test work item with some details.'
  };
  
  const contextSummary = '- #1: Previous task\n- #2: Another task';
  const workingDir = '/test/workspace/project';

  describe('buildWorkItemPrompt', () => {
    it('should include working directory emphasis', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir);
      
      expect(prompt).toContain('Working Directory');
      expect(prompt).toContain(workingDir);
      expect(prompt).toContain('DO NOT create or modify files outside this directory');
    });

    it('should include work item details', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir);
      
      expect(prompt).toContain('Current work item #42');
      expect(prompt).toContain('Test Work Item');
      expect(prompt).toContain('This is a test work item');
    });

    it('should include testing instructions', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir);
      
      expect(prompt).toContain('Test your work');
      expect(prompt).toContain('verified it works');
    });

    it('should include context summary', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir);
      
      expect(prompt).toContain('Previously completed work items');
      expect(prompt).toContain('#1: Previous task');
    });

    it('should mention terminal commands and git', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir);
      
      expect(prompt).toContain('terminal commands');
      expect(prompt).toContain('git');
    });

    it('should mention mailbox tools for team communication', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir);
      
      expect(prompt).toContain('mailbox tools');
    });

    it('should not redundantly list tool signatures', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir);
      
      // Tools are registered via SDK and copilot-instructions.md, not in prompt
      expect(prompt).not.toContain('get_team_roster()');
      expect(prompt).not.toContain('CRITICAL EXECUTION REQUIREMENTS');
    });

    it('should protect agent source code', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir);
      
      expect(prompt).toContain('DO NOT modify agent source code');
    });
  });

  describe('manager role', () => {
    const teamMembers = [
      { hostname: 'dev-host', role: 'developer', responsibilities: 'Write code' },
      { hostname: 'qa-host', role: 'qa', responsibilities: 'Test code' },
    ];

    it('should produce delegation prompt for manager role', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir, 'manager', teamMembers);
      
      expect(prompt).toContain('PROJECT MANAGER');
      expect(prompt).toContain('send_message()');
    });

    it('should include team members in manager prompt', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir, 'manager', teamMembers);
      
      expect(prompt).toContain('dev-host');
      expect(prompt).toContain('developer');
      expect(prompt).toContain('qa-host');
    });

    it('should include get_team_roster hint when no team members provided', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir, 'manager');
      
      expect(prompt).toContain('get_team_roster()');
    });

    it('should include work item details in manager prompt', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir, 'manager', teamMembers);
      
      expect(prompt).toContain('Test Work Item');
      expect(prompt).toContain('#42');
    });

    it('should include context summary in manager prompt', () => {
      const prompt = buildWorkItemPrompt(workItem, contextSummary, workingDir, 'manager', teamMembers);
      
      expect(prompt).toContain('Previously completed work items');
      expect(prompt).toContain('#1: Previous task');
    });
  });
});
