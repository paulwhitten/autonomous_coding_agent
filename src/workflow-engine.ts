// Workflow Engine
//
// Loads workflow definitions, manages task state, renders prompts,
// gates tools, and executes deterministic state transitions.
//
// The engine sits between the message/work-item system and the LLM.
// It decides WHAT the LLM sees (prompt + tool set) and WHERE the task
// goes next (transition).  The LLM only does the creative work inside
// each state.

import {
  WorkflowDefinition,
  StateDefinition,
  StateCommand,
  TaskState,
  StateTransitionRecord,
  StateExecutionResult,
  WorkflowAssignment,
  OutOfBandMessage,
  WorkflowMessage,
  WorkflowInstance,
  StateVariableDefinition,
  ExitEvaluation,
  DataRef,
  WorkflowNote,
  StatePermissions,
  TOOL_GROUPS,
  WorkflowValidationError,
} from './workflow-types.js';
import { readFile } from 'fs/promises';
import pino from 'pino';

// Marker used to embed / extract structured messages in message content.
// Uses an HTML comment so it is invisible when the markdown is rendered
// but trivially parseable by the engine.
const MSG_MARKER_START = '<!-- WORKFLOW_MSG:';
const MSG_MARKER_END   = ':END_WORKFLOW_MSG -->';

// Generic prompt used for OOB messages — full tool access, no state template.
const OOB_PROMPT = `You have received an urgent out-of-band message that requires immediate attention.
This is NOT part of your normal workflow state. Handle the request below, then report
what you did.

**Priority:** {{priority}}
**Reason:** {{reason}}

**Message:**
{{content}}

Address this now. Use any tools necessary.`;

// Tools available for OOB messages (broad access)
const OOB_TOOLS = [
  'terminal', 'file_ops', 'git', 'mailbox:read', 'mailbox:send', 'reporting', 'team',
];

/**
 * Workflow engine.
 *
 * Responsibilities:
 *   - Load and validate workflow definitions from JSON files
 *   - Create and track task instances moving through workflows
 *   - Render state-specific prompts with template substitution
 *   - Resolve allowed tool sets (expanding tool groups)
 *   - Execute deterministic state transitions on success/failure
 *   - Serialize/deserialize task state for inter-agent transport
 */
export class WorkflowEngine {
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private activeTasks: Map<string, TaskState> = new Map();
  private instances: Map<string, WorkflowInstance> = new Map();
  private instanceCounter: number = 0;

  constructor(private logger: pino.Logger) {}

  // -----------------------------------------------------------------------
  // Workflow loading
  // -----------------------------------------------------------------------

  /**
   * Load a workflow definition from a JSON file.
   */
  async loadWorkflowFromFile(filePath: string): Promise<WorkflowDefinition> {
    const content = await readFile(filePath, 'utf-8');
    const def = JSON.parse(content) as WorkflowDefinition;
    return this.loadWorkflow(def);
  }

  /**
   * Load a workflow definition from a parsed object.
   */
  loadWorkflow(def: WorkflowDefinition): WorkflowDefinition {
    this.validateWorkflow(def);
    this.workflows.set(def.id, def);
    this.logger.info(
      { id: def.id, states: Object.keys(def.states).length, version: def.version },
      `Loaded workflow: ${def.name}`,
    );
    return def;
  }

  // -----------------------------------------------------------------------
  // Task lifecycle
  // -----------------------------------------------------------------------

  /**
   * Create a new task in a workflow.
   *
   * @param workflowId  Which workflow to use
   * @param taskId      Unique task identifier
   * @param context     Initial context variables (taskTitle, taskDescription, etc.)
   */
  createTask(
    workflowId: string,
    taskId: string,
    context: Record<string, string> = {},
  ): TaskState {
    const workflow = this.getWorkflowOrThrow(workflowId);

    const task: TaskState = {
      taskId,
      workflowId,
      currentState: workflow.initialState,
      context: { ...workflow.globalContext, ...context },
      retryCount: 0,
      history: [],
      notes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.activeTasks.set(taskId, task);
    this.logger.info({ taskId, workflowId, state: task.currentState }, 'Created task');
    return task;
  }

  /**
   * Load a task that was deserialized from a message.
   * If a task with the same ID already exists, it is replaced.
   */
  loadTask(task: TaskState): void {
    this.activeTasks.set(task.taskId, task);
  }

  /**
   * Remove a completed/escalated task from the active set.
   */
  removeTask(taskId: string): void {
    this.activeTasks.delete(taskId);
  }

  // -----------------------------------------------------------------------
  // Workflow instances
  // -----------------------------------------------------------------------

  /**
   * Create a new instance of a workflow definition.
   *
   * A workflow instance is a running execution of a named workflow.
   * The definition is the blueprint; the instance is the object.
   * Multiple instances of the same definition can run concurrently.
   *
   * @param workflowId  Which workflow definition to instantiate
   * @param taskId      Task identifier for the instance's task
   * @param context     Initial context variables (merged with globalContext)
   * @param label       Optional human-readable label
   * @returns The created WorkflowInstance (also activates the task)
   */
  createInstance(
    workflowId: string,
    taskId: string,
    context: Record<string, string> = {},
    label?: string,
  ): WorkflowInstance {
    const workflow = this.getWorkflowOrThrow(workflowId);

    // Create the underlying task (existing mechanism, backward compatible)
    const taskState = this.createTask(workflowId, taskId, context);

    // Initialize instance-scoped variables from workflow definition defaults
    const variables: Record<string, string> = {};
    if (workflow.variables) {
      for (const vdef of workflow.variables) {
        if (vdef.default !== undefined) {
          variables[vdef.name] = vdef.default;
        }
      }
    }

    // Also initialize state-level variables with scope="instance"
    const initialStateDef = workflow.states[workflow.initialState];
    if (initialStateDef?.variables) {
      for (const vdef of initialStateDef.variables) {
        const scope = vdef.scope ?? 'instance';
        if (scope === 'instance' && vdef.default !== undefined) {
          variables[vdef.name] = vdef.default;
        }
      }
    }

    this.instanceCounter++;
    const instanceId = `${workflowId}-${this.instanceCounter}-${Date.now()}`;

    const instance: WorkflowInstance = {
      instanceId,
      workflowId,
      label: label ?? `${workflow.name}#${this.instanceCounter}`,
      variables,
      taskState,
      dataRefs: {},
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.instances.set(instanceId, instance);

    this.logger.info(
      {
        instanceId,
        workflowId,
        workflowName: workflow.name,
        taskId,
        variableCount: Object.keys(variables).length,
      },
      `Created workflow instance: ${instance.label}`,
    );

    return instance;
  }

  /**
   * Get a workflow instance by ID.
   */
  getInstance(instanceId: string): WorkflowInstance | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * Get all instances of a given workflow definition.
   */
  getInstancesByWorkflow(workflowId: string): WorkflowInstance[] {
    const results: WorkflowInstance[] = [];
    for (const inst of this.instances.values()) {
      if (inst.workflowId === workflowId) {
        results.push(inst);
      }
    }
    return results;
  }

  /**
   * Get all active (running) instances.
   */
  getActiveInstances(): WorkflowInstance[] {
    return [...this.instances.values()].filter(i => i.status === 'running');
  }

  /**
   * Update instance variables (e.g. after state exit promotes state-scoped
   * variables to instance scope).
   */
  updateInstanceVariables(
    instanceId: string,
    updates: Record<string, string>,
  ): void {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      this.logger.warn({ instanceId }, 'Cannot update variables: instance not found');
      return;
    }
    Object.assign(inst.variables, updates);
    inst.updatedAt = new Date().toISOString();
  }

  /**
   * Mark an instance as completed or failed.
   */
  completeInstance(
    instanceId: string,
    status: 'completed' | 'failed' | 'cancelled' = 'completed',
  ): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    inst.status = status;
    inst.updatedAt = new Date().toISOString();
    this.logger.info({ instanceId, status }, `Workflow instance ${status}`);
  }

  /**
   * Remove an instance from the active set.
   */
  removeInstance(instanceId: string): void {
    this.instances.delete(instanceId);
  }

  // -----------------------------------------------------------------------
  // Data references
  // -----------------------------------------------------------------------

  /**
   * Register a data reference produced by a state.
   *
   * Called after a state completes to record its output artifacts.
   * The ref is stored in both the instance's dataRefs map and
   * (lightweight) in the task state for message transport.
   *
   * @param instanceId  Workflow instance (or null for task-only mode)
   * @param taskId      Task that produced the data
   * @param ref         The data reference to register
   */
  registerDataRef(
    instanceId: string | null,
    taskId: string,
    ref: DataRef,
  ): void {
    // Stamp provenance if not already set
    if (!ref.producedBy) {
      const task = this.activeTasks.get(taskId);
      if (task) {
        const workflow = this.workflows.get(task.workflowId);
        const stateDef = workflow?.states[task.currentState];
        ref.producedBy = {
          state: task.currentState,
          role: stateDef?.role ?? 'unknown',
          timestamp: new Date().toISOString(),
          instanceId: instanceId ?? undefined,
        };
      }
    }

    // Store in instance scope
    if (instanceId) {
      const inst = this.instances.get(instanceId);
      if (inst) {
        inst.dataRefs[ref.key] = ref;
        inst.updatedAt = new Date().toISOString();
      }
    }

    // Also store in task state for message transport
    const task = this.activeTasks.get(taskId);
    if (task) {
      if (!task.dataRefs) task.dataRefs = {};
      task.dataRefs[ref.key] = ref;
    }

    this.logger.info(
      {
        key: ref.key,
        uri: ref.uri,
        instanceId,
        taskId,
        state: ref.producedBy?.state,
      },
      `Registered data ref: ${ref.key}`,
    );
  }

  /**
   * Resolve a data reference by key.
   *
   * Looks up the ref in instance scope first, then task scope.
   * Returns the DataRef metadata (URI, hash, provenance) but
   * does NOT fetch the actual content.  Content resolution is
   * the caller's responsibility (scheme-dependent).
   */
  resolveDataRef(
    instanceId: string | null,
    taskId: string,
    key: string,
  ): DataRef | undefined {
    // Instance scope takes precedence
    if (instanceId) {
      const inst = this.instances.get(instanceId);
      if (inst?.dataRefs[key]) return inst.dataRefs[key];
    }

    // Fall back to task scope
    const task = this.activeTasks.get(taskId);
    return task?.dataRefs?.[key];
  }

  /**
   * Get all data refs available to a task (merged instance + task scope).
   */
  getAvailableDataRefs(
    instanceId: string | null,
    taskId: string,
  ): Record<string, DataRef> {
    const taskRefs = this.activeTasks.get(taskId)?.dataRefs ?? {};

    if (instanceId) {
      const inst = this.instances.get(instanceId);
      if (inst) {
        return { ...taskRefs, ...inst.dataRefs };
      }
    }

    return { ...taskRefs };
  }

  /**
   * Validate that required input data refs are available.
   *
   * Checks the current state's dataPackage.inputs and verifies each
   * required entry has a resolvable ref in scope.
   *
   * @returns List of missing ref keys (empty = all available)
   */
  validateInputDataRefs(
    instanceId: string | null,
    taskId: string,
  ): string[] {
    const { state } = this.getStateInfo(taskId);
    if (!state.dataPackage?.inputs) return [];

    const missing: string[] = [];
    for (const entry of state.dataPackage.inputs) {
      const required = entry.required !== false; // default true
      if (required) {
        const ref = this.resolveDataRef(instanceId, taskId, entry.key);
        if (!ref) missing.push(entry.key);
      }
    }
    return missing;
  }

  /**
   * Validate that required output data refs were produced.
   *
   * Checks the current state's dataPackage.outputs against registered refs.
   *
   * @returns List of missing ref keys (empty = all produced)
   */
  validateOutputDataRefs(
    instanceId: string | null,
    taskId: string,
  ): string[] {
    const { state } = this.getStateInfo(taskId);
    if (!state.dataPackage?.outputs) return [];

    const missing: string[] = [];
    for (const entry of state.dataPackage.outputs) {
      const required = entry.required !== false;
      if (required) {
        const ref = this.resolveDataRef(instanceId, taskId, entry.key);
        if (!ref) missing.push(entry.key);
      }
    }
    return missing;
  }

  /**
   * Get the merged variable context for a task within an instance.
   *
   * Merges (in order, later wins):
   *   1. Workflow globalContext
   *   2. Instance variables
   *   3. Task context
   *   4. State-scoped variable defaults (for current state)
   *
   * This is used when composing prompts and exit evaluation questions.
   */
  getInstanceContext(instanceId: string): Record<string, string> {
    const inst = this.instances.get(instanceId);
    if (!inst) return {};

    const workflow = this.workflows.get(inst.workflowId);
    if (!workflow) return inst.variables;

    const stateDef = workflow.states[inst.taskState.currentState];
    const stateVarDefaults: Record<string, string> = {};
    if (stateDef?.variables) {
      for (const vdef of stateDef.variables) {
        if (vdef.default !== undefined) {
          stateVarDefaults[vdef.name] = vdef.default;
        }
      }
    }

    return {
      ...workflow.globalContext,
      ...inst.variables,
      ...inst.taskState.context,
      ...stateVarDefaults,
    };
  }

  /**
   * Get the exit evaluation spec for a task's current state, if defined.
   */
  getExitEvaluation(taskId: string): ExitEvaluation | undefined {
    const { state } = this.getStateInfo(taskId);
    return state.exitEvaluation;
  }

  /**
   * Promote instance-scoped variables from the current state to the
   * instance variable map.  Called after a successful state exit.
   */
  promoteStateVariables(instanceId: string, taskId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;

    const { state } = this.getStateInfo(taskId);
    if (!state.variables) return;

    for (const vdef of state.variables) {
      const scope = vdef.scope ?? 'instance';
      if (scope === 'instance') {
        // If the task context has a value for this variable, promote it
        const value = inst.taskState.context[vdef.name];
        if (value !== undefined) {
          inst.variables[vdef.name] = value;
        }
      }
    }

    inst.updatedAt = new Date().toISOString();
  }

  // -----------------------------------------------------------------------
  // Task notes (inter-agent scratchpad)
  // -----------------------------------------------------------------------

  /**
   * Append a note to the task's shared scratchpad.
   *
   * Notes persist across state transitions and are rendered in every
   * subsequent prompt, giving each agent full visibility into prior
   * observations, QA findings, and rework reasons.
   *
   * @param taskId  Task to annotate
   * @param role    Role of the agent writing the note (e.g. "qa")
   * @param content Free-form text (findings, issues, context)
   */
  addNote(taskId: string, role: string, content: string): void {
    const task = this.getTaskOrThrow(taskId);
    // Ensure notes array exists (backward compat with older serialized tasks)
    if (!task.notes) {
      task.notes = [];
    }
    task.notes.push({
      state: task.currentState,
      role,
      content,
      timestamp: new Date().toISOString(),
    });
    task.updatedAt = new Date().toISOString();
    this.logger.info(
      { taskId, state: task.currentState, role, contentLen: content.length },
      'Note added to task',
    );
  }

  /**
   * Get all notes for a task, ordered chronologically.
   */
  getNotes(taskId: string): WorkflowNote[] {
    const task = this.getTaskOrThrow(taskId);
    return task.notes ?? [];
  }

  // -----------------------------------------------------------------------
  // State introspection
  // -----------------------------------------------------------------------

  /**
   * Get the current state definition for a task.
   */
  getStateInfo(taskId: string): {
    task: TaskState;
    state: StateDefinition;
    workflow: WorkflowDefinition;
  } {
    const task = this.getTaskOrThrow(taskId);
    const workflow = this.getWorkflowOrThrow(task.workflowId);
    const state = workflow.states[task.currentState];
    if (!state) {
      throw new Error(
        `State '${task.currentState}' not found in workflow '${task.workflowId}'`,
      );
    }
    return { task, state, workflow };
  }

  /**
   * Get the rendered prompt for the current state.
   *
   * Combines:
   * 1. State history context (what prior states accomplished)
   * 2. State's base prompt (the "how")
   * 3. Tool guidance (recommended tools for this state)
   * 4. Task-specific prompt (the "what")
   *
   * Template variables are substituted from accumulated task context.
   */
  getPrompt(taskId: string): string {
    const { task, state } = this.getStateInfo(taskId);

    const sections: string[] = [];

    // 1. Render accumulated context from prior states
    const historyBlock = this.renderContextHistory(task);
    if (historyBlock) {
      sections.push(historyBlock);
    }

    // 2. Base state prompt (the procedural instructions)
    sections.push(this.substituteTemplate(state.prompt, task.context));

    // 3. Advisory tool guidance (never a hard restriction)
    const recommended = this.getRecommendedTools(taskId);
    if (recommended.length > 0) {
      sections.push(
        `**Recommended tools for this state:** ${recommended.join(', ')}\n` +
        `(All standard tools remain available -- these are the ones most relevant to this step.)`
      );
    }

    // 4. Restricted tool warning (enforced deny-list)
    const restricted = this.getRestrictedTools(taskId);
    if (restricted.length > 0) {
      sections.push(
        `**Restricted tools (do NOT use):** ${restricted.join(', ')}\n` +
        `These tools are blocked for this workflow state.`
      );
    }

    // 5. Task-specific prompt
    const taskPrompt = task.context._taskPrompt;
    if (taskPrompt) {
      sections.push(
        `---\n**Task Details:**\n${this.substituteTemplate(taskPrompt, task.context)}`
      );
    }

    return sections.join('\n\n');
  }

  /**
   * Render a summary of what prior states accomplished.
   *
   * Gives the LLM continuity across workflow states by surfacing
   * the accumulated context and transition history.
   */
  private renderContextHistory(task: TaskState): string | null {
    if (task.history.length === 0) {
      return null;
    }

    const lines: string[] = ['**Prior workflow history:**'];

    for (const record of task.history) {
      const status = record.result === 'success' ? 'completed' : record.result;
      let line = `- **${record.fromState}** (${record.role}): ${status}`;
      if (record.outputs) {
        const outputKeys = Object.keys(record.outputs);
        if (outputKeys.length > 0) {
          const outputSummary = outputKeys.map(k => {
            const v = record.outputs![k];
            // Truncate long values for prompt readability
            const display = v.length > 120 ? v.substring(0, 117) + '...' : v;
            return `${k}=${display}`;
          }).join(', ');
          line += ` [${outputSummary}]`;
        }
      }
      if (record.reason) {
        line += ` -- ${record.reason}`;
      }
      lines.push(line);
    }

    // Surface key accumulated context values
    const contextKeys = Object.keys(task.context).filter(
      k => !k.startsWith('_') && k !== 'projectPath' && k !== 'buildCommand'
        && k !== 'testCommand' && k !== 'lintCommand'
    );
    if (contextKeys.length > 0) {
      lines.push('');
      lines.push('**Accumulated context:**');
      for (const key of contextKeys) {
        const val = task.context[key];
        const display = val.length > 200 ? val.substring(0, 197) + '...' : val;
        lines.push(`- ${key}: ${display}`);
      }
    }

    // Render agent notes (inter-agent scratchpad)
    const notes = task.notes ?? [];
    if (notes.length > 0) {
      lines.push('');
      lines.push('**Agent notes:**');
      for (const note of notes) {
        // Truncate individual notes to keep prompts manageable
        const display = note.content.length > 500
          ? note.content.substring(0, 497) + '...'
          : note.content;
        lines.push(`- [${note.state}] (${note.role}): ${display}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get the flat list of recommended tool names for the current state.
   *
   * These are ADVISORY -- rendered into the prompt as guidance but
   * never used as an SDK whitelist.  All built-in tools remain
   * available to avoid the catastrophic failures caused by overly
   * restrictive tool gating.
   *
   * Tool group names are expanded to individual tools.
   */
  getRecommendedTools(taskId: string): string[] {
    const { state } = this.getStateInfo(taskId);
    return this.expandToolList(state.allowedTools);
  }

  /**
   * Backward-compatible alias for getRecommendedTools.
   * @deprecated Use getRecommendedTools() -- tools are advisory, not gated.
   */
  getAllowedTools(taskId: string): string[] {
    return this.getRecommendedTools(taskId);
  }

  /**
   * Get the flat list of restricted (blocked) tools for the current state.
   *
   * Unlike recommended tools, restricted tools are ENFORCED.
   * The agent should refuse to invoke any tool on this list.
   *
   * Tool group names are expanded to individual tools.
   */
  getRestrictedTools(taskId: string): string[] {
    const { state } = this.getStateInfo(taskId);
    return this.expandToolList(state.restrictedTools ?? []);
  }

  /**
   * Check if a specific tool is restricted (blocked) in the current state.
   *
   * Returns true if the tool should be DENIED.
   */
  isToolRestricted(taskId: string, toolName: string): boolean {
    return this.getRestrictedTools(taskId).includes(toolName);
  }

  /**
   * Check if a specific tool is allowed in the current state.
   *
   * A tool is allowed if it is NOT on the restricted list.
   * The allowedTools list is advisory only.
   */
  isToolAllowed(taskId: string, toolName: string): boolean {
    return !this.isToolRestricted(taskId, toolName);
  }

  /**
   * Get SDK permission overrides declared for the current state.
   *
   * Returns the state's `permissions` object if present, or undefined
   * if the state does not declare any permission overrides.
   */
  getStatePermissions(taskId: string): StatePermissions | undefined {
    const { state } = this.getStateInfo(taskId);
    return state.permissions;
  }

  /**
   * Check if a task is in a terminal state.
   */
  isTerminal(taskId: string): boolean {
    const { task, workflow } = this.getStateInfo(taskId);
    return workflow.terminalStates.includes(task.currentState);
  }

  /**
   * Get the role responsible for the current state.
   */
  getCurrentRole(taskId: string): string {
    const { state } = this.getStateInfo(taskId);
    return state.role;
  }

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  /**
   * Transition the task based on execution result.
   *
   * Validates required outputs on success.  Tracks retry counts on
   * failure and escalates when maxRetries is exceeded.
   *
   * @returns Transition result with new state, role, and terminal flag.
   */
  transition(
    taskId: string,
    result: StateExecutionResult,
  ): { newState: string; role: string; isTerminal: boolean } {
    const { task, state, workflow } = this.getStateInfo(taskId);
    const fromState = task.currentState;

    // On success: validate required outputs are present
    if (result.success && state.requiredOutputs) {
      const missing = state.requiredOutputs.filter(
        (key) => !(key in result.outputs),
      );
      if (missing.length > 0) {
        this.logger.warn(
          { taskId, state: fromState, missing },
          'Required outputs missing -- treating as failure',
        );
        result.success = false;
        result.error = `Missing required outputs: ${missing.join(', ')}`;
      }
    }

    // Merge outputs into task context
    if (result.outputs) {
      Object.assign(task.context, result.outputs);
    }

    // Execute exitActions (set_context, log) defined on the departing state.
    // These run deterministically within the engine (no LLM involvement).
    // set_context actions apply AFTER outputs merge, so they can override
    // regex-extracted values with workflow-author-defined values.
    if (state.exitActions && state.exitActions.length > 0) {
      for (const action of state.exitActions) {
        switch (action.type) {
          case 'set_context': {
            const key = action.params.key;
            const rawValue = action.params.value ?? '';
            // Template-substitute the value so {{taskId}} etc. resolve
            const value = this.substituteTemplate(rawValue, {
              ...task.context,
              taskId: task.taskId,
              role: state.role,
              state: fromState,
            });
            task.context[key] = value;
            this.logger.info(
              { taskId, action: 'set_context', key, value },
              'State action: set_context',
            );
            break;
          }
          case 'log': {
            const msg = this.substituteTemplate(
              action.params.message ?? '',
              { ...task.context, taskId: task.taskId, role: state.role, state: fromState },
            );
            const level = action.params.level ?? 'info';
            if (level === 'warn') {
              this.logger.warn({ taskId, action: 'log' }, msg);
            } else {
              this.logger.info({ taskId, action: 'log' }, msg);
            }
            break;
          }
          case 'send_to_role':
            // send_to_role is handled by the agent layer (mailbox routing),
            // not by the engine.  Skip here.
            break;
          default:
            this.logger.warn(
              { taskId, actionType: (action as any).type },
              'Unknown exitAction type -- skipping',
            );
        }
      }
    }

    // Determine next state
    let newState: string;

    if (result.success) {
      newState = state.transitions.onSuccess ?? task.currentState;
      task.retryCount = 0;
    } else {
      const maxRetries = state.maxRetries ?? 2;
      task.retryCount++;

      if (task.retryCount > maxRetries) {
        // Exceeded retries -- follow failure transition or escalate.
        // Guard against infinite self-loops: if onFailure points back
        // to the current state, force to the escalation terminal state.
        const failTarget = state.transitions.onFailure ?? 'ESCALATED';
        if (failTarget === fromState) {
          // Find the escalation terminal state: prefer ESCALATED, then
          // FAILED, then any terminal state that isn't the success target.
          const successTarget = state.transitions.onSuccess;
          const escalationState =
            workflow.terminalStates.find((s) => s === 'ESCALATED') ??
            workflow.terminalStates.find((s) => s === 'FAILED') ??
            workflow.terminalStates.find((s) => s !== successTarget) ??
            workflow.terminalStates[0] ??
            'ESCALATED';
          newState = escalationState;
          this.logger.warn(
            { taskId, state: fromState, retries: task.retryCount, maxRetries, escalationState },
            'Max retries exceeded on self-loop -- forcing escalation',
          );
        } else {
          newState = failTarget;
          this.logger.warn(
            { taskId, state: fromState, retries: task.retryCount, maxRetries },
            'Max retries exceeded',
          );
        }
      } else {
        // Retry: go to failure state (which may loop back, e.g. REWORK -> VALIDATING)
        newState = state.transitions.onFailure ?? fromState;
      }
    }

    // Record the transition
    const record: StateTransitionRecord = {
      fromState,
      toState: newState,
      result: result.success ? 'success' : 'failure',
      role: state.role,
      timestamp: new Date().toISOString(),
      outputs: result.outputs,
      reason: result.error,
    };
    task.history.push(record);
    task.currentState = newState;
    task.updatedAt = new Date().toISOString();

    const isTerminal = workflow.terminalStates.includes(newState);
    const newStateDef = workflow.states[newState];

    this.logger.info(
      {
        taskId,
        from: fromState,
        to: newState,
        result: result.success ? 'success' : 'failure',
        role: newStateDef?.role,
        isTerminal,
      },
      'State transition',
    );

    return {
      newState,
      role: newStateDef?.role ?? 'unknown',
      isTerminal,
    };
  }

  // -----------------------------------------------------------------------
  // Assignment message building
  // -----------------------------------------------------------------------

  /**
   * Build a WorkflowAssignment message for the task's current state.
   *
   * The manager calls this to create a structured message envelope.
   * The manager then resolves `targetRole` to a hostname via team roster
   * and sends the message.
   *
   * @param taskId     Active task ID
   * @param taskPrompt Task-specific prompt content (the "what").
   *                   This is appended to the state's base prompt (the "how").
   * @returns          Structured assignment ready to be serialized and sent
   */
  buildAssignment(taskId: string, taskPrompt: string): WorkflowAssignment {
    const { task, state } = this.getStateInfo(taskId);

    // Preserve the original seed prompt so it can be forwarded cleanly
    // across hops without nesting the entire prior assignment envelope.
    if (!task.context._originalTaskPrompt) {
      task.context._originalTaskPrompt = taskPrompt;
    }

    // Always use the original prompt for forwarding -- prevents the
    // exponential JSON nesting that occurs when each hop's cleanPrompt
    // contains the full prior assignment payload.
    const forwardPrompt = task.context._originalTaskPrompt;

    // Store the taskPrompt in context so getPrompt() can compose it
    task.context._taskPrompt = forwardPrompt;
    task.updatedAt = new Date().toISOString();

    return {
      type: 'workflow',
      workflowId: task.workflowId,
      taskId: task.taskId,
      targetState: task.currentState,
      targetRole: state.role,
      taskPrompt: forwardPrompt,
      taskState: { ...task },
    };
  }

  /**
   * Receive and ingest a WorkflowAssignment on the receiving agent.
   *
   * Loads the task state, validates the target state matches, and
   * makes the task active so getPrompt() and getRecommendedTools() work.
   *
   * @returns The rendered prompt (with history + tool guidance baked in),
   *          recommended tools (advisory), restricted tools (enforced),
   *          and the task ID for tracking.
   */
  receiveAssignment(assignment: WorkflowAssignment): {
    prompt: string;
    allowedTools: string[];
    restrictedTools: string[];
    taskId: string;
  } {
    // Ensure the workflow is loaded
    const workflow = this.getWorkflowOrThrow(assignment.workflowId);

    // Load the task state from the assignment
    const task = assignment.taskState;

    // Merge globalContext defaults into the task context.  Task context
    // wins on conflict so accumulated values from prior states are
    // preserved.  This is necessary because externally-seeded tasks
    // (e.g. via the CLI) may not have had globalContext merged at
    // creation time.
    task.context = { ...workflow.globalContext, ...task.context };

    task.context._taskPrompt = assignment.taskPrompt;
    // Preserve the original seed prompt if not already set
    if (!task.context._originalTaskPrompt) {
      task.context._originalTaskPrompt = assignment.taskPrompt;
    }
    this.activeTasks.set(task.taskId, task);

    // Validate state matches
    if (task.currentState !== assignment.targetState) {
      this.logger.warn(
        {
          taskId: task.taskId,
          expected: assignment.targetState,
          actual: task.currentState,
        },
        'Assignment targetState does not match task currentState',
      );
    }

    return {
      prompt: this.getPrompt(task.taskId),
      allowedTools: this.getRecommendedTools(task.taskId),
      restrictedTools: this.getRestrictedTools(task.taskId),
      taskId: task.taskId,
    };
  }

  // -----------------------------------------------------------------------
  // Out-of-band (OOB) message handling
  // -----------------------------------------------------------------------

  /**
   * Build an OutOfBandMessage for urgent communication outside the
   * workflow state machine.
   */
  buildOOB(
    content: string,
    reason: string,
    priority: 'HIGH' | 'NORMAL' = 'HIGH',
    relatedTaskId?: string,
    resumeState?: string,
  ): OutOfBandMessage {
    return {
      type: 'oob',
      priority,
      reason,
      content,
      relatedTaskId,
      resumeState,
    };
  }

  /**
   * Receive an OOB message and produce a prompt + tool set.
   *
   * OOB messages use a generic prompt template with broad tool access.
   * No tools are restricted for OOB messages (they are emergency actions).
   * If the OOB references a task, that task's context is available for
   * variable substitution in the prompt.
   */
  receiveOOB(oob: OutOfBandMessage): {
    prompt: string;
    allowedTools: string[];
    restrictedTools: string[];
    relatedTaskId?: string;
  } {
    const context: Record<string, string> = {
      priority: oob.priority,
      reason: oob.reason,
      content: oob.content,
    };

    // If related to a task, merge that task's context
    if (oob.relatedTaskId) {
      const task = this.activeTasks.get(oob.relatedTaskId);
      if (task) {
        Object.assign(context, task.context);
      }
    }

    return {
      prompt: this.substituteTemplate(OOB_PROMPT, context),
      allowedTools: this.expandToolList(OOB_TOOLS),
      restrictedTools: [],  // OOB messages have no tool restrictions
      relatedTaskId: oob.relatedTaskId,
    };
  }

  // -----------------------------------------------------------------------
  // Message serialization (pack/unpack structured messages)
  // -----------------------------------------------------------------------

  /**
   * Serialize a WorkflowMessage (assignment or OOB) into a string
   * suitable for embedding in mailbox message content.
   */
  packMessage(content: string, message: WorkflowMessage): string {
    const json = JSON.stringify(message);
    return `${content}\n\n${MSG_MARKER_START}${json}${MSG_MARKER_END}`;
  }

  /**
   * Extract a WorkflowMessage from message content.
   * Returns null if no structured message is embedded.
   */
  unpackMessage(content: string): WorkflowMessage | null {
    const startIdx = content.indexOf(MSG_MARKER_START);
    if (startIdx === -1) return null;

    const jsonStart = startIdx + MSG_MARKER_START.length;
    // Use lastIndexOf to find the OUTERMOST end marker.  The taskPrompt
    // may embed a prior envelope (nested markers) from an earlier phase,
    // so indexOf would incorrectly match the inner end marker.
    const endIdx = content.lastIndexOf(MSG_MARKER_END);
    if (endIdx === -1 || endIdx < jsonStart) return null;

    const json = content.substring(jsonStart, endIdx);
    try {
      return JSON.parse(json) as WorkflowMessage;
    } catch {
      this.logger.warn('Failed to parse embedded workflow message');
      return null;
    }
  }

  /**
   * Strip the embedded workflow message from content,
   * returning clean content for display/processing.
   */
  stripMessage(content: string): string {
    const startIdx = content.indexOf(MSG_MARKER_START);
    if (startIdx === -1) return content;

    const endIdx = content.indexOf(MSG_MARKER_END);
    if (endIdx === -1) return content;

    const before = content.substring(0, startIdx).trimEnd();
    const after = content.substring(endIdx + MSG_MARKER_END.length).trimStart();
    return (before + (after ? '\n' + after : '')).trimEnd();
  }

  /**
   * Determine if a raw message is a workflow message or OOB.
   * Convenience for the agent loop to route messages appropriately.
   *
   * @deprecated Prefer using the MessageType header from the parsed
   *   MailboxMessage instead of sniffing the body content.
   */
  classifyMessage(content: string): 'workflow' | 'oob' | 'unstructured' {
    const msg = this.unpackMessage(content);
    if (!msg) return 'unstructured';
    return msg.type;
  }

  // -----------------------------------------------------------------------
  // Strict-schema payload validation
  // -----------------------------------------------------------------------

  /**
   * Validate and cast a parsed JSON payload to a WorkflowAssignment.
   *
   * Returns null (with a warning log) if required fields are missing.
   */
  validateWorkflowPayload(payload: Record<string, unknown>): WorkflowAssignment | null {
    const required = ['type', 'workflowId', 'taskId', 'targetState', 'targetRole', 'taskPrompt', 'taskState'];
    for (const key of required) {
      if (!(key in payload)) {
        this.logger.warn({ missingField: key }, 'Invalid workflow payload -- missing required field');
        return null;
      }
    }
    if (payload.type !== 'workflow') {
      this.logger.warn({ type: payload.type }, 'Invalid workflow payload -- type is not "workflow"');
      return null;
    }
    return payload as unknown as WorkflowAssignment;
  }

  /**
   * Validate and cast a parsed JSON payload to an OutOfBandMessage.
   */
  validateOOBPayload(payload: Record<string, unknown>): OutOfBandMessage | null {
    const required = ['type', 'priority', 'reason', 'content'];
    for (const key of required) {
      if (!(key in payload)) {
        this.logger.warn({ missingField: key }, 'Invalid OOB payload -- missing required field');
        return null;
      }
    }
    if (payload.type !== 'oob') {
      this.logger.warn({ type: payload.type }, 'Invalid OOB payload -- type is not "oob"');
      return null;
    }
    return payload as unknown as OutOfBandMessage;
  }

  // -----------------------------------------------------------------------
  // Legacy serialization (backward compat, delegates to new pack/unpack)
  // -----------------------------------------------------------------------

  serializeTaskState(taskId: string): string {
    const task = this.getTaskOrThrow(taskId);
    return JSON.stringify(task);
  }

  deserializeTaskState(json: string): TaskState {
    const task = JSON.parse(json) as TaskState;
    this.activeTasks.set(task.taskId, task);
    return task;
  }

  packTaskState(content: string, taskId: string): string {
    const task = this.getTaskOrThrow(taskId);
    const assignment: WorkflowAssignment = {
      type: 'workflow',
      workflowId: task.workflowId,
      taskId: task.taskId,
      targetState: task.currentState,
      targetRole: this.getCurrentRole(taskId),
      taskPrompt: task.context._taskPrompt ?? '',
      taskState: { ...task },
    };
    return this.packMessage(content, assignment);
  }

  extractTaskState(content: string): TaskState | null {
    const msg = this.unpackMessage(content);
    if (!msg || msg.type !== 'workflow') return null;
    const task = (msg as WorkflowAssignment).taskState;
    this.activeTasks.set(task.taskId, task);
    return task;
  }

  stripTaskState(content: string): string {
    return this.stripMessage(content);
  }

  // -----------------------------------------------------------------------
  // Getters for inspection and testing
  // -----------------------------------------------------------------------

  getTask(taskId: string): TaskState | undefined {
    return this.activeTasks.get(taskId);
  }

  getWorkflow(workflowId: string): WorkflowDefinition | undefined {
    return this.workflows.get(workflowId);
  }

  getLoadedWorkflowIds(): string[] {
    return [...this.workflows.keys()];
  }

  getActiveTaskIds(): string[] {
    return [...this.activeTasks.keys()];
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  // -----------------------------------------------------------------------
  // State commands (onEntryCommands / onExitCommands)
  // -----------------------------------------------------------------------

  /**
   * Return the resolved entry or exit commands for a task's current state.
   *
   * Template variables ({{branch}}, {{taskId}}, {{role}}, {{state}}, etc.)
   * are substituted from the merged task context.  Extra synthetic
   * variables (taskId, role, state) are injected so they are always
   * available even if not explicitly set in the context.
   *
   * @param taskId - Active task identifier
   * @param phase  - 'entry' for onEntryCommands, 'exit' for onExitCommands
   * @returns Array of resolved StateCommand objects (empty if none defined)
   */
  getStateCommands(
    taskId: string,
    phase: 'entry' | 'exit',
  ): StateCommand[] {
    const { task, state } = this.getStateInfo(taskId);

    const raw: StateCommand[] | undefined =
      phase === 'entry' ? state.onEntryCommands : state.onExitCommands;

    if (!raw || raw.length === 0) return [];

    // Build a context map with synthetic variables so templates like
    // {{taskId}}, {{role}}, {{state}} resolve without the workflow
    // author needing to set them explicitly in globalContext.
    const ctx: Record<string, string> = {
      ...task.context,
      taskId: task.taskId,
      role: state.role,
      state: task.currentState,
    };

    return raw.map((cmd) => ({
      command: this.substituteTemplate(cmd.command, ctx),
      reason: this.substituteTemplate(cmd.reason, ctx),
      failOnError: cmd.failOnError,
      captureAs: cmd.captureAs,
    }));
  }

  /**
   * Get all active tasks assigned to a specific role in their current state.
   */
  getTasksForRole(role: string): TaskState[] {
    const results: TaskState[] = [];
    for (const task of this.activeTasks.values()) {
      const workflow = this.workflows.get(task.workflowId);
      if (!workflow) continue;
      const stateDef = workflow.states[task.currentState];
      if (stateDef?.role === role) {
        results.push(task);
      }
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Replace {{variable}} placeholders in a template string.
   * Unreplaced variables are left as-is (visible for debugging).
   */
  private substituteTemplate(
    template: string,
    context: Record<string, string>,
  ): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      return context[key] ?? `{{${key}}}`;
    });
  }

  /**
   * Expand a tool list that may contain group names into flat tool names.
   */
  private expandToolList(tools: string[]): string[] {
    const result = new Set<string>();
    for (const entry of tools) {
      const group = TOOL_GROUPS[entry];
      if (group) {
        for (const tool of group) {
          result.add(tool);
        }
      } else {
        result.add(entry);
      }
    }
    return [...result];
  }

  /**
   * Validate a workflow definition.
   * Throws WorkflowValidationError on problems.
   */
  private validateWorkflow(def: WorkflowDefinition): void {
    const id = def.id ?? '<unnamed>';
    const stateNames = new Set(Object.keys(def.states));

    if (!def.id) {
      throw new WorkflowValidationError(id, 'Missing required field: id');
    }
    if (!def.initialState) {
      throw new WorkflowValidationError(id, 'Missing required field: initialState');
    }
    if (!stateNames.has(def.initialState)) {
      throw new WorkflowValidationError(
        id,
        `initialState '${def.initialState}' is not defined in states`,
      );
    }
    if (!def.terminalStates || def.terminalStates.length === 0) {
      throw new WorkflowValidationError(id, 'At least one terminalState is required');
    }
    for (const ts of def.terminalStates) {
      if (!stateNames.has(ts)) {
        throw new WorkflowValidationError(
          id,
          `terminalState '${ts}' is not defined in states`,
        );
      }
    }

    // Validate each non-terminal state has valid transitions
    for (const [name, state] of Object.entries(def.states)) {
      if (def.terminalStates.includes(name)) continue;

      if (!state.role) {
        throw new WorkflowValidationError(id, `State '${name}' is missing role`);
      }
      if (!state.prompt && state.prompt !== '') {
        throw new WorkflowValidationError(id, `State '${name}' is missing prompt`);
      }
      if (
        state.transitions.onSuccess &&
        !stateNames.has(state.transitions.onSuccess)
      ) {
        throw new WorkflowValidationError(
          id,
          `State '${name}' onSuccess references unknown state '${state.transitions.onSuccess}'`,
        );
      }
      if (
        state.transitions.onFailure &&
        !stateNames.has(state.transitions.onFailure)
      ) {
        throw new WorkflowValidationError(
          id,
          `State '${name}' onFailure references unknown state '${state.transitions.onFailure}'`,
        );
      }
    }

    // Validate reachability: every non-terminal state should be reachable
    // from the initial state (warn, don't throw)
    const reachable = new Set<string>();
    const queue = [def.initialState];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      const stateDef = def.states[current];
      if (!stateDef) continue;
      if (stateDef.transitions.onSuccess && !reachable.has(stateDef.transitions.onSuccess)) {
        queue.push(stateDef.transitions.onSuccess);
      }
      if (stateDef.transitions.onFailure && !reachable.has(stateDef.transitions.onFailure)) {
        queue.push(stateDef.transitions.onFailure);
      }
    }
    for (const name of stateNames) {
      if (!reachable.has(name)) {
        this.logger.warn(
          { workflowId: id, state: name },
          'Unreachable state detected',
        );
      }
    }
  }

  private getWorkflowOrThrow(workflowId: string): WorkflowDefinition {
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new Error(`Unknown workflow: '${workflowId}'`);
    return wf;
  }

  private getTaskOrThrow(taskId: string): TaskState {
    const task = this.activeTasks.get(taskId);
    if (!task) throw new Error(`Unknown task: '${taskId}'`);
    return task;
  }
}
