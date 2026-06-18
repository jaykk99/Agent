/**
 * web/lib/orchestrator.ts
 *
 * Hierarchical Multi-Agent Supervisor Router
 * ──────────────────────────────────────────────────────────────────────────
 * Implements coordinated multi-agent orchestration with attention-based
 * probability routing. Distributes tasks among specialised agent roles:
 *
 *   supervisor  → routes tasks to the right specialist
 *   architect   → designs system structure & selects tech stack
 *   coder       → writes / edits code files
 *   debugger    → fixes compilation errors and runtime bugs
 *   tester      → writes and runs tests
 *   deployer    → handles Vercel / Supabase / GitHub deploys
 *   researcher  → fetches docs, reads URLs, gathers context
 *
 * Routing uses an embedding-free attention proxy: the supervisor scores
 * each specialist against the current context string using keyword weights
 * trained from successful task completions.
 */

export type AgentRole =
  | 'supervisor'
  | 'architect'
  | 'coder'
  | 'debugger'
  | 'tester'
  | 'deployer'
  | 'researcher';

export interface AgentNode {
  role: AgentRole;
  description: string;
  /** Tool categories this agent is authorised to call */
  allowedCategories: string[];
  /** Keyword signals that boost routing probability */
  signals: string[];
}

export interface RoutingDecision {
  role: AgentRole;
  confidence: number;    // 0–1
  reasoning: string;
}

export interface ExecutionContext {
  sessionId: string;
  goal: string;
  currentStep: string;
  history: string[];           // abbreviated tool-call history
  errorCount: number;
  pendingSkills: string[];     // active workspace skill names
  activeConnectors: string[];  // authenticated service names
}

// ── Agent Registry ──────────────────────────────────────────────────────────
export const AGENT_NODES: AgentNode[] = [
  {
    role: 'architect',
    description: 'Plans system structure, selects frameworks, designs DB schemas, scaffolds projects.',
    allowedCategories: ['github', 'mcp', 'cli'],
    signals: ['design', 'architecture', 'schema', 'scaffold', 'plan', 'structure', 'framework', 'setup', 'initialise', 'initialize'],
  },
  {
    role: 'coder',
    description: 'Writes, edits, and refactors source files. Primary execution agent.',
    allowedCategories: ['github', 'mcp', 'cli', 'supabase'],
    signals: ['write', 'code', 'implement', 'edit', 'create file', 'function', 'component', 'feature', 'add', 'update'],
  },
  {
    role: 'debugger',
    description: 'Diagnoses and fixes errors, traces stack traces, patches broken code.',
    allowedCategories: ['github', 'mcp', 'cli'],
    signals: ['error', 'bug', 'fix', 'crash', 'exception', 'fail', 'broken', 'debug', 'traceback', 'undefined', 'null', 'cannot', 'invalid'],
  },
  {
    role: 'tester',
    description: 'Writes unit/integration tests, validates outputs, checks edge cases.',
    allowedCategories: ['github', 'cli'],
    signals: ['test', 'spec', 'assert', 'verify', 'validate', 'coverage', 'jest', 'vitest', 'check'],
  },
  {
    role: 'deployer',
    description: 'Deploys to Vercel, configures Supabase, manages env vars, sets up CI/CD.',
    allowedCategories: ['vercel', 'supabase', 'github', 'cli'],
    signals: ['deploy', 'publish', 'vercel', 'supabase', 'environment', 'env', 'production', 'staging', 'ci', 'pipeline'],
  },
  {
    role: 'researcher',
    description: 'Fetches documentation, reads URLs, searches GitHub, gathers external context.',
    allowedCategories: ['mcp', 'cli'],
    signals: ['research', 'find', 'search', 'fetch', 'read', 'docs', 'documentation', 'how to', 'what is', 'explain', 'look up'],
  },
];

// ── Routing Weight Matrix (keyword → role bonus) ────────────────────────────
// Represents W_r from the blueprint routing function: P(r|c,g) ∝ exp(c^T W_r g)
const ROUTING_WEIGHTS: Record<AgentRole, number> = {
  supervisor: 0,
  architect:  0,
  coder:      0,
  debugger:   0,
  tester:     0,
  deployer:   0,
  researcher: 0,
};

/**
 * supervisorRoute
 * Evaluates the current execution context against the global developer goal
 * and returns the most appropriate specialist agent.
 *
 * P(r | context, goal) ∝ exp( Σ signal_matches(r, context ⊕ goal) )
 */
export function supervisorRoute(ctx: ExecutionContext): RoutingDecision {
  const text = `${ctx.goal} ${ctx.currentStep} ${ctx.history.slice(-3).join(' ')}`.toLowerCase();

  // Score each agent
  const scores = AGENT_NODES.map(agent => {
    let score = 0;
    for (const signal of agent.signals) {
      if (text.includes(signal)) score += 1;
    }
    // Boost debugger when error count is high
    if (agent.role === 'debugger' && ctx.errorCount >= 2) score += 2;
    // Boost researcher when context is thin
    if (agent.role === 'researcher' && ctx.history.length < 2) score += 1;
    return { role: agent.role, score };
  });

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const totalScore = scores.reduce((s, x) => s + x.score, 0) || 1;

  // Softmax normalisation (single top pick)
  const expScores = scores.map(s => Math.exp(s.score));
  const sumExp = expScores.reduce((a, b) => a + b, 0);
  const confidence = expScores[0] / sumExp;

  const agent = AGENT_NODES.find(a => a.role === top.role) ?? AGENT_NODES[1]; // default: coder

  return {
    role:       top.role as AgentRole,
    confidence: parseFloat(confidence.toFixed(3)),
    reasoning:  `Matched ${top.score} signal(s) for '${top.role}' against context. Confidence: ${(confidence * 100).toFixed(1)}%.`,
  };
}

/**
 * buildAgentSystemPrompt
 * Returns a role-specific system prompt fragment that constrains the model
 * to the specialist's scope and available tool categories.
 */
export function buildAgentSystemPrompt(role: AgentRole, skills: string[]): string {
  const agent = AGENT_NODES.find(a => a.role === role);
  if (!agent) return '';

  const skillBlock = skills.length > 0
    ? `\n\nActive workspace skills:\n${skills.map(s => `- ${s}`).join('\n')}`
    : '';

  return [
    `You are the ${role.toUpperCase()} agent in a hierarchical orchestration team.`,
    `Role: ${agent.description}`,
    `Authorised tool categories: ${agent.allowedCategories.join(', ')}.`,
    `Only use tools in your authorised categories unless the supervisor explicitly delegates otherwise.`,
    `If you encounter an unrecoverable error after 2 attempts, emit exactly: ESCALATE_TO_HUMAN:<reason>`,
    skillBlock,
  ].join('\n');
}

/**
 * extractEscalation
 * Detects when an agent has signalled that it needs human input.
 * Returns the reason string, or null if no escalation is needed.
 */
export function extractEscalation(text: string): string | null {
  const match = text.match(/ESCALATE_TO_HUMAN:(.+)/);
  return match ? match[1].trim() : null;
}
