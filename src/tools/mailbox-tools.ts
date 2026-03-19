// Custom tools for mailbox operations

import { defineTool } from '@github/copilot-sdk';
import { MailboxManager } from '../mailbox.js';
import pino from 'pino';

// Create logger for tool invocations
const toolLogger = pino({ name: 'MailboxTools' });

/**
 * Callback fired after a successful send_message tool invocation.
 * Used by the manager agent to record outbound delegations for WIP gating.
 */
export type OnMessageSentCallback = (info: {
  toHostname: string;
  toRole: string;
  subject: string;
  filepath: string;
}) => void;

export function createMailboxTools(mailbox: MailboxManager, onMessageSent?: OnMessageSentCallback) {
  
  const checkMailbox = defineTool('check_mailbox', {
    description: 'Check the external mailbox for new task assignments or messages',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      toolLogger.info('🔧 TOOL INVOKED: check_mailbox');
      const messages = await mailbox.checkForNewMessages();
      
      if (messages.length === 0) {
        return {
          hasNewMessages: false,
          count: 0,
          messages: []
        };
      }
      
      return {
        hasNewMessages: true,
        count: messages.length,
        messages: messages.map(msg => ({
          filename: msg.filename,
          from: msg.from,
          subject: msg.subject,
          priority: msg.priority || 'NORMAL',
          date: msg.date.toISOString(),
          preview: msg.content.substring(0, 200) + '...'
        }))
      };
    }
  });
  
  const readMessage = defineTool('read_message', {
    description: 'Read the full content of a specific mailbox message',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'The filename of the message to read'
        }
      },
      required: ['filename']
    },
    handler: async ({ filename }: { filename: string }) => {
      const messages = await mailbox.checkForNewMessages();
      const message = messages.find(msg => msg.filename === filename);
      
      if (!message) {
        return {
          success: false,
          error: `Message not found: ${filename}`
        };
      }
      
      return {
        success: true,
        message: {
          filename: message.filename,
          from: message.from,
          to: message.to,
          subject: message.subject,
          priority: message.priority,
          date: message.date.toISOString(),
          content: message.content
        }
      };
    }
  });
  
  const archiveMessage = defineTool('archive_message', {
    description: 'Archive a processed message by moving it to the archive folder',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'The filename of the message to archive'
        }
      },
      required: ['filename']
    },
    handler: async ({ filename }: { filename: string }) => {
      const messages = await mailbox.checkForNewMessages();
      const message = messages.find(msg => msg.filename === filename);
      
      if (!message) {
        return {
          success: false,
          error: `Message not found: ${filename}`
        };
      }
      
      await mailbox.archiveMessage(message);
      
      return {
        success: true,
        message: `Archived: ${filename}`
      };
    }
  });
  
  const sendCompletionReport = defineTool('send_completion_report', {
    description: 'Send a task completion report to the manager',
    parameters: {
      type: 'object',
      properties: {
        taskSubject: {
          type: 'string',
          description: 'The subject of the completed task'
        },
        results: {
          type: 'string',
          description: 'Detailed results and outcomes of the task'
        }
      },
      required: ['taskSubject', 'results']
    },
    handler: async ({ taskSubject, results }: { taskSubject: string; results: string }) => {
      await mailbox.sendCompletionReport(taskSubject, results);
      
      return {
        success: true,
        message: 'Completion report sent to manager'
      };
    }
  });
  
  const escalateIssue = defineTool('escalate_issue', {
    description: 'Escalate an issue or blocker to the manager when stuck or need guidance',
    parameters: {
      type: 'object',
      properties: {
        issue: {
          type: 'string',
          description: 'Brief description of the issue or blocker'
        },
        context: {
          type: 'string',
          description: 'Detailed context about what was attempted and why stuck'
        }
      },
      required: ['issue', 'context']
    },
    handler: async ({ issue, context }: { issue: string; context: string }) => {
      await mailbox.escalate(issue, context);
      
      return {
        success: true,
        message: 'Issue escalated to manager with HIGH priority'
      };
    }
  });
  
  const getTeamRoster = defineTool('get_team_roster', {
    description: 'Get the list of all agents on the team with their roles and capabilities',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      toolLogger.info('🔧 TOOL INVOKED: get_team_roster');
      const roster = await mailbox.getTeamRoster();
      
      if (!roster) {
        return {
          available: false,
          message: 'No team.json file found in mailbox. Team roster not configured.'
        };
      }
      
      return {
        available: true,
        team: roster.team,
        agentCount: roster.agents.length,
        agents: roster.agents,
        roles: roster.roles
      };
    }
  });
  
  const findAgentsByRole = defineTool('find_agents_by_role', {
    description: 'Find all agents with a specific role (e.g., developer, qa, manager)',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'The role to search for (e.g., "developer", "qa", "manager")'
        }
      },
      required: ['role']
    },
    handler: async ({ role }: { role: string }) => {
      const roster = await mailbox.getTeamRoster();
      
      if (!roster) {
        return {
          found: false,
          message: 'Team roster not available'
        };
      }
      
      const agents = roster.agents.filter(agent => agent.role === role);
      
      return {
        found: agents.length > 0,
        role: role,
        count: agents.length,
        agents: agents.map(a => ({
          id: a.id,
          hostname: a.hostname,
          description: a.description,
          capabilities: a.capabilities
        }))
      };
    }
  });
  
  const findAgentsByCapability = defineTool('find_agents_by_capability', {
    description: 'Find agents with a specific capability or skill (e.g., "python", "validation", "circuit-processing")',
    parameters: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'The capability to search for (e.g., "python", "validation")'
        }
      },
      required: ['capability']
    },
    handler: async ({ capability }: { capability: string }) => {
      const roster = await mailbox.getTeamRoster();
      
      if (!roster) {
        return {
          found: false,
          message: 'Team roster not available'
        };
      }
      
      const agents = roster.agents.filter(agent => 
        agent.capabilities?.includes(capability)
      );
      
      return {
        found: agents.length > 0,
        capability: capability,
        count: agents.length,
        agents: agents.map(a => ({
          id: a.id,
          hostname: a.hostname,
          role: a.role,
          description: a.description
        }))
      };
    }
  });
  
  const getAgentInfo = defineTool('get_agent_info', {
    description: 'Get detailed information about a specific agent by their ID',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'The agent ID (e.g., "dev-server-1_developer")'
        }
      },
      required: ['agentId']
    },
    handler: async ({ agentId }: { agentId: string }) => {
      const roster = await mailbox.getTeamRoster();
      
      if (!roster) {
        return {
          found: false,
          message: 'Team roster not available'
        };
      }
      
      const agent = roster.agents.find(a => a.id === agentId);
      
      if (!agent) {
        return {
          found: false,
          message: `Agent ${agentId} not found in team roster`
        };
      }
      
      return {
        found: true,
        agent: agent
      };
    }
  });
  
  const sendMessage = defineTool('send_message', {
    description: 'Send a message to another agent on the team. Use to delegate tasks, request information, or coordinate work.',
    parameters: {
      type: 'object',
      properties: {
        toHostname: {
          type: 'string',
          description: 'Target agent hostname ONLY (NOT the full agent ID). For example if the agent ID is "test-sdk_developer", the hostname is just "test-sdk". Get hostnames from get_team_roster().'
        },
        toRole: {
          type: 'string',
          description: 'Target agent role as a separate field (e.g., "developer", "qa", "manager"). This is combined with hostname to form the agent ID.'
        },
        subject: {
          type: 'string',
          description: 'Brief subject line for the message'
        },
        content: {
          type: 'string',
          description: 'Full message content with task details, requirements, or information'
        },
        priority: {
          type: 'string',
          enum: ['HIGH', 'NORMAL', 'LOW'],
          description: 'Message priority: HIGH (urgent), NORMAL (default), LOW (background)'
        }
      },
      required: ['toHostname', 'toRole', 'subject', 'content']
    },
    handler: async ({
      toHostname,
      toRole,
      subject,
      content,
      priority
    }: {
      toHostname: string;
      toRole: string;
      subject: string;
      content: string;
      priority?: 'HIGH' | 'NORMAL' | 'LOW';
    }) => {
      toolLogger.info({ toHostname, toRole, subject, priority }, '🔧 TOOL INVOKED: send_message');

      // Sender-side backpressure: check recipient's unread mailbox depth
      const MAX_RECIPIENT_MAILBOX = 10;
      try {
        const recipientDepth = await mailbox.getRecipientQueueDepth(toHostname, toRole);
        if (recipientDepth >= MAX_RECIPIENT_MAILBOX) {
          toolLogger.warn(
            { toHostname, toRole, recipientDepth, threshold: MAX_RECIPIENT_MAILBOX },
            'Backpressure: recipient mailbox is full, message deferred'
          );
          return {
            success: false,
            deferred: true,
            message: `BACKPRESSURE: ${toHostname}_${toRole} has ${recipientDepth} unread messages (limit: ${MAX_RECIPIENT_MAILBOX}). The agent is busy -- do NOT send more messages to this agent right now. Wait for completion reports before delegating additional tasks.`,
            recipientQueueDepth: recipientDepth,
            threshold: MAX_RECIPIENT_MAILBOX
          };
        }
      } catch (err) {
        // If we can't check, proceed with send (fail open)
        toolLogger.warn({ error: String(err) }, 'Could not check recipient queue depth, proceeding with send');
      }

      const filepath = await mailbox.sendMessage(
        toHostname,
        toRole,
        subject,
        content,
        priority
      );

      // Notify the agent that a message was sent (for WIP tracking)
      if (onMessageSent) {
        try {
          onMessageSent({ toHostname, toRole, subject, filepath });
        } catch (err) {
          toolLogger.warn({ error: String(err) }, 'onMessageSent callback failed');
        }
      }
      
      return {
        success: true,
        message: `Message sent to ${toHostname}_${toRole}`,
        filepath: filepath,
        priority: priority || 'NORMAL'
      };
    }
  });
  
  const sendBroadcast = defineTool('send_broadcast', {
    description: 'Send a broadcast message to all team members. Use for team-wide announcements, updates, or coordination.',
    parameters: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Brief subject line for the broadcast'
        },
        content: {
          type: 'string',
          description: 'Full broadcast content'
        },
        priority: {
          type: 'string',
          enum: ['HIGH', 'NORMAL', 'LOW'],
          description: 'Broadcast priority: HIGH (urgent), NORMAL (default), LOW (background)'
        }
      },
      required: ['subject', 'content']
    },
    handler: async ({
      subject,
      content,
      priority
    }: {
      subject: string;
      content: string;
      priority?: 'HIGH' | 'NORMAL' | 'LOW';
    }) => {
      const filepath = await mailbox.sendBroadcast(
        subject,
        content,
        priority
      );
      
      return {
        success: true,
        message: 'Broadcast sent to all team members',
        filepath: filepath,
        priority: priority || 'NORMAL'
      };
    }
  });
  
  return [
    checkMailbox,
    readMessage,
    archiveMessage,
    sendCompletionReport,
    escalateIssue,
    getTeamRoster,
    findAgentsByRole,
    findAgentsByCapability,
    getAgentInfo,
    sendMessage,
    sendBroadcast
  ];
}
