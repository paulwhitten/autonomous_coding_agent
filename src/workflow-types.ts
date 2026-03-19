// Workflow state machine types
//
// Defines a data-driven schema for multi-agent workflows.
// Each workflow is a directed graph of states. Each state has:
//   - A role (which agent handles it)
//   - A prompt template (what the LLM sees)
//   - Allowed tools (what the LLM can use)
//   - Transitions (on success -> state X, on failure -> state Y)
//
// The LLM never interprets multi-step instructions.  It gets one prompt
// for one state and executes it with a gated tool set.  Transitions are
// deterministic code, not LLM decisions.

// ---------------------------------------------------------------------------
// Workflow Definition (loaded from JSON)
// ---------------------------------------------------------------------------

/**
 * Complete workflow definition.
 * This is loaded from a .workflow.json file and describes the full
 * directed graph of states, including role assignments, prompt templates,
 * tool permissions, and transition rules.
 */
export interface WorkflowDefinition {
  /** Unique workflow identifier (e.g., "dev-qa-merge") */
  id: string;

  /** Human-readable name */
  name: string;

  /** What this workflow does */
  description: string;

  /** Schema version for forward compatibility */
  version: string;

  /** State to assign when a new task enters this workflow */
  initialState: string;

  /** States that signify the task is complete (no further transitions) */
  terminalStates: string[];

  /**
   * Global context variables available to every prompt template in the
   * workflow.  Merged with per-task context; task context wins on conflict.
   */
  globalContext: Record<string, string>;

  /**
   * Instance-scoped variable declarations.
   *
   * Variables declared here are initialized when a WorkflowInstance is
   * created and persist for the lifetime of that instance.  They are
   * available to all state prompts via {{variable}} substitution and
   * to exit evaluations.
   */
  variables?: StateVariableDefinition[];

  /** State definitions keyed by state name */
  states: Record<string, StateDefinition>;
}

// ---------------------------------------------------------------------------
// Data References and State Data Packages
// ---------------------------------------------------------------------------

/**
 * A reference to data rather than the data itself.
 *
 * Data references decouple workflow state from raw content.  Instead of
 * stuffing file contents into the context bag, states declare what data
 * they need and produce as typed references.  The runtime resolves refs
 * to actual content when needed (read on demand, not carry everywhere).
 *
 * This enables:
 *   - **Distribution:** refs travel in messages; data stays in stores
 *   - **Provenance:** every ref records who/when/where it was produced
 *   - **Versioning:** content-addressed refs (hash) are immutable
 *   - **Size management:** messages stay small regardless of artifact size
 *
 * URI scheme examples:
 *   - `git://repo/path/to/file@commitSha`   — git-tracked file
 *   - `file://relative/path`                — local filesystem
 *   - `artifact://instance-id/key`          — workflow artifact store
 *   - `s3://bucket/key`                     — cloud object store
 *   - `sha256://abc123...`                  — content-addressed
 */
export interface DataRef {
  /** Reference key (used in data packages and prompt templates as {{data.key}}) */
  key: string;

  /**
   * URI pointing to the data.  Scheme determines resolution strategy.
   * Supports {{variable}} template substitution.
   */
  uri: string;

  /** MIME type hint (e.g. "text/markdown", "application/json") */
  mediaType?: string;

  /** Human-readable description of what this data is */
  description?: string;

  /**
   * Content hash for integrity verification.
   * When set, the resolver can verify that fetched content matches.
   * Scheme: "sha256:<hex>" or "md5:<hex>"
   */
  contentHash?: string;

  /**
   * Who/what produced this data reference.
   * Set automatically by the engine when a state produces an output ref.
   */
  producedBy?: {
    /** State that produced this ref */
    state: string;
    /** Role of the executor */
    role: string;
    /** ISO timestamp */
    timestamp: string;
    /** Instance ID if within a workflow instance */
    instanceId?: string;
  };
}

/**
 * Declares the data a workflow state consumes and produces.
 *
 * This is the "contract" between states.  A state's inputs are the
 * outputs of prior states (or external data).  The engine validates
 * that required inputs are available before entering the state and
 * that declared outputs are produced before allowing a success exit.
 *
 * Analogy:
 *   - BPMN: Data Input Association / Data Output Association
 *   - Step Functions: InputPath / ResultPath
 *   - Unix pipes: stdin / stdout contract
 */
export interface StateDataPackage {
  /**
   * Data references this state expects to be available on entry.
   *
   * The engine resolves these refs and makes their content available
   * to the prompt via {{data.key}} substitution or as tool context.
   *
   * If `required` is true (default), the engine blocks entry until
   * the ref is resolvable.
   */
  inputs?: DataPackageEntry[];

  /**
   * Data references this state is expected to produce on exit.
   *
   * The executor (LLM, service, script) registers output refs via
   * StateExecutionResult.  The engine validates required outputs
   * before allowing a success transition.
   */
  outputs?: DataPackageEntry[];
}

/**
 * A single entry in a state's data package (input or output).
 */
export interface DataPackageEntry {
  /** Reference key — must be unique within the package */
  key: string;

  /** Human-readable description */
  description?: string;

  /**
   * URI template for the data.  For inputs, this is where to find
   * the data.  For outputs, this is where the data should be written.
   * Supports {{variable}} substitution from instance/task context.
   *
   * May be omitted for outputs if the executor chooses the location.
   */
  uri?: string;

  /** Expected MIME type */
  mediaType?: string;

  /**
   * Whether this entry is required.
   *   - For inputs: state entry is blocked until ref resolves
   *   - For outputs: success transition is blocked until ref exists
   * Defaults to true.
   */
  required?: boolean;
}

// ---------------------------------------------------------------------------
// Exit Evaluation (structured transition decision)
// ---------------------------------------------------------------------------

/**
 * Structured evaluation performed after a state's work items complete.
 *
 * Instead of regex-scanning free-form LLM output for failure indicators,
 * the workflow author declares a specific question and constrained answer
 * format.  The engine asks the LLM, parses the response, and maps it to
 * a success/failure routing decision.
 *
 * This solves the "scarlet vs. red" problem: the question is domain-
 * specific, the answer format is constrained, and the mapping is
 * declarative.  No hardcoded patterns.
 *
 * Example (boolean):
 *   {
 *     prompt: "Did all validation tests pass and all REQ annotations exist?",
 *     responseFormat: "boolean",
 *     mapping: { "true": "success", "false": "failure" },
 *     defaultOutcome: "failure"
 *   }
 *
 * Example (enum):
 *   {
 *     prompt: "What is the overall verification status?",
 *     responseFormat: "enum",
 *     choices: ["pass", "partial", "fail"],
 *     mapping: { "pass": "success", "partial": "failure", "fail": "failure" },
 *     defaultOutcome: "failure"
 *   }
 */
export interface ExitEvaluation {
  /**
   * Question asked to the LLM after work items complete.
   * Should be answerable with a constrained response.
   * Supports {{variable}} template substitution.
   */
  prompt: string;

  /**
   * Expected response format.
   *   - "boolean": LLM must answer true or false (yes/no also accepted)
   *   - "enum": LLM must answer with one of the declared choices
   */
  responseFormat: 'boolean' | 'enum';

  /**
   * For enum format: the valid choices the LLM can pick from.
   * Ignored for boolean format.
   */
  choices?: string[];

  /**
   * Maps parsed response values to routing outcomes.
   *
   * For boolean: keys are "true" and "false".
   * For enum: keys are each of the declared choices.
   * Values are "success" or "failure".
   */
  mapping: Record<string, 'success' | 'failure'>;

  /**
   * Outcome when the LLM response cannot be parsed into any
   * recognized value.  Defaults to "failure" (safe default).
   */
  defaultOutcome?: 'success' | 'failure';
}

// ---------------------------------------------------------------------------
// State Variable Declaration
// ---------------------------------------------------------------------------

/**
 * Declared variable on a workflow state or workflow definition.
 *
 * Variables give workflow authors a typed, schema-driven alternative
 * to the untyped `context: Record<string, string>` bag.  They are
 * initialized with defaults on state entry and persisted to the
 * workflow instance scope when `scope` is "instance".
 */
export interface StateVariableDefinition {
  /** Variable name (used as key in context/variables maps) */
  name: string;

  /** Data type for validation and prompt rendering */
  type: 'string' | 'boolean' | 'number';

  /** Default value (stored as string in context, parsed when needed) */
  default?: string;

  /** Human-readable description (included in prompt context) */
  description?: string;

  /**
   * Variable scope:
   *   - "state": cleared when leaving the state
   *   - "instance": persists across all states in the workflow instance
   * Defaults to "instance".
   */
  scope?: 'state' | 'instance';
}

/**
 * A single state in the workflow graph.
 */
export interface StateDefinition {
  /** Human-readable state name */
  name: string;

  /** Which agent role handles this state */
  role: string;

  /** What this state does (for logging / debugging) */
  description: string;

  /**
   * Prompt template sent to the LLM.  Uses {{variable}} substitution.
   *
   * Available variables (populated from task context):
   *   taskId, taskTitle, taskDescription, acceptanceCriteria,
   *   branch, commitSha, testResults, rejectionReason,
   *   plus any workflow globalContext keys and accumulated outputs
   *   from earlier states.
   */
  prompt: string;

  /**
   * Recommended tools for this state (advisory, NOT a whitelist).
   *
   * These are rendered into the prompt as guidance ("focus on these
   * tools") but all SDK built-in tools remain available.  This avoids
   * the catastrophic failures that occur when an allowlist blocks
   * tools the LLM actually needs (e.g., grep_search, read_file).
   *
   * Accepts individual tool names or group names from TOOL_GROUPS.
   */
  allowedTools: string[];

  /**
   * Tools explicitly blocked in this state (deny-list).
   *
   * Unlike allowedTools (advisory), restrictedTools is enforced:
   * the engine will refuse calls to tools on this list.  Use this
   * sparingly for safety boundaries, e.g. preventing QA from running
   * `git push`, or preventing a developer from sending broadcasts.
   *
   * Accepts individual tool names or group names from TOOL_GROUPS.
   */
  restrictedTools?: string[];

  /**
   * Context keys that MUST be present before the engine allows a
   * success transition.  The LLM (or tool wrappers) must set these
   * via StateExecutionResult.outputs.
   */
  requiredOutputs?: string[];

  /** Transition rules */
  transitions: {
    /** State to move to on success (null = terminal) */
    onSuccess: string | null;
    /** State to move to on failure (null = terminal or stay) */
    onFailure: string | null;
  };

  /** Maximum failures before escalation (default: 2) */
  maxRetries?: number;

  /** Hard time limit for this state in milliseconds */
  timeoutMs?: number;

  /**
   * Actions the engine executes automatically on entering this state.
   * These are code actions, not LLM actions.
   */
  entryActions?: StateAction[];

  /**
   * Actions the engine executes automatically on successful exit.
   */
  exitActions?: StateAction[];

  /**
   * Shell commands executed directly by the engine (via
   * child_process.execSync) on entering this state, BEFORE the main
   * work items.  These run mechanically -- the LLM is not involved.
   *
   * Template variables (e.g. {{branch}}, {{taskId}}) are resolved
   * from accumulated task context + globalContext.
   */
  onEntryCommands?: StateCommand[];

  /**
   * Shell commands executed directly by the engine on exiting this
   * state, AFTER the main work items complete but BEFORE the state
   * transition.  These run mechanically -- the LLM is not involved.
   */
  onExitCommands?: StateCommand[];

  /**
   * Structured exit evaluation for this state.
   *
   * When present, the engine asks the LLM a constrained question after
   * work items complete and BEFORE the transition fires.  The parsed
   * answer determines success/failure routing.
   *
   * When absent, the engine falls back to the existing behavior
   * (regex-based fail detection or default success).
   */
  exitEvaluation?: ExitEvaluation;

  /**
   * Variables scoped to this state.
   *
   * Initialized with defaults on state entry.  Variables with
   * scope="state" are cleared on exit; scope="instance" variables
   * are promoted to the workflow instance's variable map.
   */
  variables?: StateVariableDefinition[];

  /**
   * Required tasks that the decomposition MUST include as work items.
   *
   * Each string describes a required deliverable or activity.  The
   * decomposition prompt builder composes these into a sentence like:
   * "Work items MUST include: <task1>, <task2>, <task3>."
   *
   * This gives workflow authors structured control over what the LLM
   * includes in its work item breakdown without relying on the LLM
   * to infer requirements from prose buried in the task prompt.
   */
  tasks?: string[];

  /**
   * Additional free-form guidance injected into the decomposition prompt.
   *
   * Use for domain-specific decomposition advice that doesn't fit the
   * structured `tasks` array (e.g. ordering constraints, grouping
   * rules, or emphasis on particular quality attributes).
   *
   * When both `tasks` and `decompositionPrompt` are present, the
   * tasks sentence is rendered first, followed by this text.
   */
  decompositionPrompt?: string;

  /**
   * Data package declaring the state's input and output data contracts.
   *
   * Inputs are resolved before the state prompt is rendered.
   * Outputs are validated before a success transition is allowed.
   * Data travels by reference, not by value.
   */
  dataPackage?: StateDataPackage;

  /**
   * SDK permission overrides for this state.
   *
   * When present, the agent applies these overrides to the permission
   * handler on state entry and clears them on state exit.  This allows
   * workflow authors to enforce read-only validation states (e.g.
   * `{ "write": "deny" }`) without relying on prompt-level instructions
   * that the LLM may ignore.
   *
   * Keys are SDK permission kinds; values are PermissionPolicy strings.
   * Only specified keys are overridden -- unspecified kinds keep their
   * base config policy.
   */
  permissions?: StatePermissions;
}

/**
 * SDK permission overrides declared per workflow state.
 *
 * Each key corresponds to an SDK permission request kind.  When a state
 * declares a permission override, the agent applies it to the permission
 * handler on state entry and clears it on state exit.
 */
export interface StatePermissions {
  write?: 'allow' | 'deny' | 'workingDir';
  read?: 'allow' | 'deny' | 'workingDir';
  shell?: 'allow' | 'deny' | 'allowlist';
  url?: 'allow' | 'deny';
  mcp?: 'allow' | 'deny';
}

/**
 * A deterministic shell command executed directly by the engine
 * (child_process.execSync) at state entry or exit.  The LLM is not
 * involved -- the engine runs the command and logs stdout/stderr.
 */
export interface StateCommand {
  /** Shell command to execute (supports {{variable}} templates). */
  command: string;

  /** Human-readable reason logged by the engine for diagnostics. */
  reason: string;

  /**
   * If true (default), a command failure aborts subsequent commands
   * in the sequence.  Set to false for best-effort commands that
   * may legitimately fail (e.g. pulling from an empty remote).
   */
  failOnError?: boolean;

  /**
   * When set, the trimmed stdout of the command is stored in the
   * captured-outputs map under this key.  Designed for deterministic
   * commands like `git rev-parse HEAD` whose output must be captured
   * reliably as a workflow variable (e.g. "commitSha").
   */
  captureAs?: string;
}

/**
 * Automated action executed by the engine (not the LLM) on state
 * entry or exit.
 */
export interface StateAction {
  /**
   * Action type:
   *   - "send_to_role": auto-send the task message to the state's role
   *   - "set_context": set a context variable
   *   - "log": emit a structured log entry
   */
  type: 'send_to_role' | 'set_context' | 'log';

  /** Action-specific parameters */
  params: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Runtime Task State (persisted / carried in messages)
// ---------------------------------------------------------------------------

/**
 * Runtime state of a single task moving through a workflow.
 * Serialized and embedded in inter-agent messages so each agent
 * knows the full task history without shared mutable state.
 */
export interface TaskState {
  /** Unique task identifier */
  taskId: string;

  /** Which workflow definition this task follows */
  workflowId: string;

  /** Current state in the workflow graph */
  currentState: string;

  /**
   * Accumulated context data from all completed states.
   * Keys include branch, commitSha, testResults, rejectionReason,
   * and any requiredOutputs produced by earlier states.
   */
  context: Record<string, string>;

  /** Number of consecutive failures in the current state */
  retryCount: number;

  /** Ordered history of every state transition */
  history: StateTransitionRecord[];

  /**
   * Append-only notes left by agents during execution.
   *
   * Agents write notes to record observations, QA findings, rework
   * reasons, or any context the next agent in the pipeline needs.
   * Notes are rendered in the prompt so each agent sees the full
   * communication trail.
   */
  notes: WorkflowNote[];

  /**
   * Data references accumulated during task execution.
   *
   * Lightweight version of the instance-scoped dataRefs — travels
   * in messages so the receiving agent can resolve prior outputs.
   * Keyed by DataRef.key.
   */
  dataRefs?: Record<string, DataRef>;

  /** ISO timestamp: task creation */
  createdAt: string;

  /** ISO timestamp: last state change */
  updatedAt: string;
}

/**
 * A note left by an agent during workflow execution.
 *
 * Notes are a shared scratchpad that persists across state transitions.
 * Each agent can append notes during its phase to record observations,
 * issues found, decisions made, or context the next agent needs.
 *
 * Unlike context variables (key-value, last-writer-wins), notes are
 * append-only and ordered.  Nothing is overwritten.
 */
export interface WorkflowNote {
  /** Which workflow state the note was written in */
  state: string;

  /** Role of the agent that wrote the note */
  role: string;

  /** Note content (free-form text, findings, observations) */
  content: string;

  /** ISO timestamp */
  timestamp: string;
}

/**
 * Record of a single state transition in the task history.
 */
export interface StateTransitionRecord {
  fromState: string;
  toState: string;
  result: 'success' | 'failure' | 'timeout' | 'escalation';
  role: string;
  timestamp: string;

  /** Outputs produced during the from-state */
  outputs?: Record<string, string>;

  /** Failure reason (if result is not 'success') */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Workflow Instance (runtime execution of a workflow definition)
// ---------------------------------------------------------------------------

/**
 * A running instance of a workflow definition.
 *
 * Relationship to WorkflowDefinition:
 *   WorkflowDefinition is the blueprint (class).  WorkflowInstance is
 *   a single execution of that blueprint (object).  Multiple instances
 *   of the same definition can run concurrently with independent state.
 *
 * Relationship to TaskState:
 *   TaskState is the serializable core that travels in messages.
 *   WorkflowInstance wraps it with instance-level bookkeeping that
 *   stays in the engine (variable scope, instance ID, lifecycle).
 *
 * The instance ID is globally unique.  The task ID within the instance
 * may be the same (1:1 for simple workflows) or different (future:
 * parallel task lanes within an instance).
 */
export interface WorkflowInstance {
  /** Globally unique instance identifier */
  instanceId: string;

  /** The workflow definition this is an instance of (by id) */
  workflowId: string;

  /** Human-readable label, defaults to `workflowName + '#' + instanceId` */
  label: string;

  /**
   * Instance-scoped variables.
   *
   * Initialized from WorkflowDefinition.variables defaults on creation.
   * Updated by state exits when variables have scope="instance".
   * Available to all prompt templates and exit evaluations.
   */
  variables: Record<string, string>;

  /**
   * The task state traveling through this instance.
   *
   * Kept as the existing TaskState for backward compatibility with
   * serialization, message transport, and all existing engine methods.
   */
  taskState: TaskState;

  /**
   * Accumulated data references produced by states in this instance.
   *
   * Keyed by DataRef.key.  When a state produces an output data ref,
   * it is registered here so subsequent states can consume it as an
   * input.  This is the instance-scoped "data store".
   */
  dataRefs: Record<string, DataRef>;

  /** Instance lifecycle status */
  status: 'running' | 'completed' | 'failed' | 'cancelled';

  /** ISO timestamp: instance creation */
  createdAt: string;

  /** ISO timestamp: last activity */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Assignment Message (structured envelope between agents)
// ---------------------------------------------------------------------------

/**
 * Structured assignment message sent between agents.
 *
 * Instead of free-form text, every inter-agent message for workflow tasks
 * uses this envelope.  The engine on the receiving side uses `targetState`
 * to look up the base prompt, merges `taskPrompt` as the specific work
 * details, and gates tools per the state definition.
 *
 * The manager creates these by looking up the state's role in the workflow
 * and resolving the role to a hostname via the team roster.
 */
export interface WorkflowAssignment {
  /** Discriminator — allows the receiver to distinguish workflow messages
   *  from OOB/legacy messages. */
  type: 'workflow';

  /** Workflow identifier (e.g., "dev-qa-merge") */
  workflowId: string;

  /** Task identifier (unique across the system) */
  taskId: string;

  /** The state this assignment targets (e.g., "IMPLEMENTING", "VALIDATING") */
  targetState: string;

  /** The role that should execute this state (e.g., "developer", "qa").
   *  The sender resolves this to a hostname via team roster lookup. */
  targetRole: string;

  /**
   * Task-specific prompt content provided by the sender.
   *
   * This is the "what" — the specific work details, acceptance criteria,
   * files involved, etc.  The engine prepends the state's base prompt
   * (the "how") and appends this.
   *
   * Example: "Implement frame parsing in protocol-io crate..."
   */
  taskPrompt: string;

  /** Serialized TaskState for continuity across agents */
  taskState: TaskState;

  /**
   * Optional pre-decomposed work items.
   *
   * When present and non-empty the receiving agent SKIPS LLM-based
   * task decomposition and queues these items directly.  Each entry
   * maps to a single work-item file in the pending queue.
   *
   * When absent or empty the receiver uses LLM decomposition as usual.
   */
  workItems?: Array<{ title: string; content: string }>;
}

/**
 * Out-of-band priority message — not part of any workflow state.
 *
 * Used for urgent interrupts: corrections, blockers, rework demands,
 * or any message that needs immediate attention outside the normal
 * state machine flow.
 *
 * The receiver processes OOB messages with a generic prompt and full
 * tool access.  The result may or may not feed back into a workflow
 * task (via the optional taskId reference).
 */
export interface OutOfBandMessage {
  /** Discriminator */
  type: 'oob';

  /** Priority level for the interrupt */
  priority: 'HIGH' | 'NORMAL';

  /** Why this message is being sent outside the workflow */
  reason: string;

  /**
   * Free-form prompt content.  This is the entire instruction to the
   * agent — there is no base prompt template for OOB messages.
   */
  content: string;

  /**
   * Optional: workflow task this OOB relates to.
   * If set, the engine can correlate the OOB result back to the task
   * (e.g., pause the task, inject context, or force a transition).
   */
  relatedTaskId?: string;

  /** Optional: workflow state to return to after handling the OOB */
  resumeState?: string;
}

/**
 * Union type for all structured messages the engine handles.
 */
export type WorkflowMessage = WorkflowAssignment | OutOfBandMessage;

// ---------------------------------------------------------------------------
// Execution Interface
// ---------------------------------------------------------------------------

/**
 * Result returned by the agent after executing a state's prompt.
 * The engine uses this to decide the next transition.
 */
export interface StateExecutionResult {
  /** Whether the state completed successfully */
  success: boolean;

  /**
   * Context data produced by this execution.
   * Must include all keys listed in the state's requiredOutputs
   * for success transitions to be allowed.
   */
  outputs: Record<string, string>;

  /** Error or failure description */
  error?: string;
}

// ---------------------------------------------------------------------------
// Tool Groups
// ---------------------------------------------------------------------------

/**
 * Named groups of tools for convenience in state definitions.
 * A state can list "mailbox:send" instead of enumerating each tool.
 *
 * Used by both allowedTools (advisory) and restrictedTools (enforced).
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  'mailbox:read':  ['check_mailbox', 'read_message', 'archive_message'],
  'mailbox:send':  ['send_message', 'send_broadcast'],
  'reporting':     ['send_completion_report', 'escalate_issue'],
  'team':          ['get_team_roster', 'find_agents_by_role', 'find_agents_by_capability', 'get_agent_info'],
  'terminal':      ['run_in_terminal', 'get_terminal_output'],
  'file_ops':      ['read_file', 'create_file', 'replace_string_in_file'],
  'git':           ['run_in_terminal'],  // git is done via terminal
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Error thrown when a workflow definition fails validation.
 */
export class WorkflowValidationError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly detail: string,
  ) {
    super(`Workflow '${workflowId}' validation failed: ${detail}`);
    this.name = 'WorkflowValidationError';
  }
}
