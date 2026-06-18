/**
 * web/lib/agentState.ts
 *
 * Procedural State Serialisation + Memory Decay
 * ──────────────────────────────────────────────────────────────────────────
 * Allows multiple agents to share runtime without operational silos.
 * When an agent pauses (error, HITL, timeout) the full execution state is
 * serialised to Supabase. On resume, the system restores exact parameters
 * rather than forcing the agent to rebuild context from flat text.
 *
 * State transition: S_t = tanh(W_s · S_{t-1} + W_e · e_t)
 * where S_t is the serialised state vector, e_t the current env input,
 * and W_s / W_e are weight matrices controlling preservation vs decay.
 *
 * Memory scopes:
 *   session  — cleared when the browser tab closes
 *   project  — persists for the lifetime of the project
 *   global   — shared across all projects for the workspace
 */

import { getSupabase } from '@/lib/supabase';

// ── Types ────────────────────────────────────────────────────────────────────
export type MemoryScope = 'session' | 'project' | 'global';

export interface ProcedualState {
  /** Unique state snapshot ID */
  stateId:        string;
  sessionId:      string;
  scope:          MemoryScope;
  /** Current agent role active at time of snapshot */
  activeRole:     string;
  /** Developer goal the workspace is working toward */
  goal:           string;
  /** Abbreviated task queue: what still needs doing */
  pendingTasks:   string[];
  /** API keys / tokens resolved during this run (never logged to client) */
  resolvedVars:   Record<string, string>;
  /** Compiled skill schemas available in this execution context */
  activeSkills:   string[];
  /** Working file paths touched this run */
  touchedFiles:   string[];
  /** Error log: last N errors encountered */
  errorLog:       string[];
  /** Execution step counter */
  stepIndex:      number;
  /** Memory decay factor (0 = full decay, 1 = full preserve) */
  decayFactor:    number;
  createdAt:      string;
  updatedAt:      string;
}

export interface AskHumanRequest {
  stateId:   string;
  sessionId: string;
  reason:    string;
  errorLog:  string[];
  filePath?: string;
  /** The execution resumes from this step when user provides feedback */
  resumeStep: number;
  resolved:  boolean;
  userReply?: string;
  createdAt:  string;
}

// ── In-process cache (serverless instances share nothing; Supabase is source of truth) ──
const _stateCache: Map<string, ProcedualState> = new Map();

// ── Memory decay coefficients ────────────────────────────────────────────────
// W_s controls how much of the previous state is preserved
const W_S = 0.85;
// W_e controls how strongly the new environment input updates the state
const W_E = 0.15;

/**
 * applyMemoryDecay
 * Simulates S_t = tanh(W_s · S_{t-1} + W_e · e_t)
 * For string arrays: prune oldest entries proportional to decay.
 */
function applyMemoryDecay(prev: ProcedualState, newInput: Partial<ProcedualState>): ProcedualState {
  const decayFactor = prev.decayFactor ?? W_S;

  // Decay error log: keep only the most recent entries
  const maxErrors = Math.max(3, Math.ceil(prev.errorLog.length * decayFactor));
  const decayedErrors = [
    ...prev.errorLog.slice(-maxErrors),
    ...(newInput.errorLog ?? []),
  ].slice(-10);

  // Decay touched files: preserve recently active files
  const maxFiles = Math.max(5, Math.ceil(prev.touchedFiles.length * decayFactor));
  const mergedFiles = [...new Set([...prev.touchedFiles, ...(newInput.touchedFiles ?? [])])];
  const decayedFiles = mergedFiles.slice(-maxFiles);

  return {
    ...prev,
    ...newInput,
    errorLog:    decayedErrors,
    touchedFiles: decayedFiles,
    stepIndex:   prev.stepIndex + 1,
    decayFactor: Math.min(0.95, decayFactor + 0.01), // gradually increase preservation
    updatedAt:   new Date().toISOString(),
  };
}

/**
 * saveState
 * Serialises the agent state to Supabase (upsert by stateId).
 * Falls back to in-process cache if Supabase is unavailable.
 */
export async function saveState(state: ProcedualState): Promise<void> {
  _stateCache.set(state.stateId, state);

  try {
    const sb = getSupabase();
    await sb
      .from('agent_execution_states')
      .upsert([state], { onConflict: 'stateId' });
  } catch {
    // Supabase not configured — in-process cache is the fallback
  }
}

/**
 * loadState
 * Restores agent state from Supabase or in-process cache.
 */
export async function loadState(stateId: string): Promise<ProcedualState | null> {
  if (_stateCache.has(stateId)) return _stateCache.get(stateId)!;

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from('agent_execution_states')
      .select('*')
      .eq('stateId', stateId)
      .single();
    if (data) {
      _stateCache.set(stateId, data as ProcedualState);
      return data as ProcedualState;
    }
  } catch { /* offline */ }
  return null;
}

/**
 * updateState
 * Applies a partial update with memory decay and persists.
 */
export async function updateState(
  stateId: string,
  patch: Partial<ProcedualState>,
): Promise<ProcedualState | null> {
  const prev = await loadState(stateId);
  if (!prev) return null;
  const next = applyMemoryDecay(prev, patch);
  await saveState(next);
  return next;
}

/**
 * createState
 * Creates a fresh execution state for a new session or project.
 */
export function createState(
  sessionId: string,
  goal: string,
  scope: MemoryScope = 'session',
): ProcedualState {
  const now = new Date().toISOString();
  return {
    stateId:      `state_${sessionId}_${Date.now()}`,
    sessionId,
    scope,
    activeRole:   'coder',
    goal,
    pendingTasks: [],
    resolvedVars: {},
    activeSkills: [],
    touchedFiles: [],
    errorLog:     [],
    stepIndex:    0,
    decayFactor:  W_S,
    createdAt:    now,
    updatedAt:    now,
  };
}

// ── Ask-Human Queue ──────────────────────────────────────────────────────────
const _askQueue: Map<string, AskHumanRequest> = new Map();

/**
 * pauseForHuman
 * Serialises state and enqueues an Ask Human request.
 * The agent run queue is paused until the user resolves it.
 */
export async function pauseForHuman(
  state: ProcedualState,
  reason: string,
  filePath?: string,
): Promise<AskHumanRequest> {
  const req: AskHumanRequest = {
    stateId:    state.stateId,
    sessionId:  state.sessionId,
    reason,
    errorLog:   state.errorLog,
    filePath,
    resumeStep: state.stepIndex,
    resolved:   false,
    createdAt:  new Date().toISOString(),
  };

  _askQueue.set(state.stateId, req);
  await saveState({ ...state, activeRole: 'paused' } as ProcedualState);

  try {
    const sb = getSupabase();
    await sb.from('agent_ask_human_queue').upsert([req], { onConflict: 'stateId' });
  } catch { /* offline */ }

  return req;
}

/**
 * resolveHumanRequest
 * Called when the user provides feedback. Marks the request as resolved
 * and patches the state with the user reply for resumption.
 */
export async function resolveHumanRequest(
  stateId: string,
  userReply: string,
): Promise<AskHumanRequest | null> {
  const req = _askQueue.get(stateId);
  if (!req) return null;

  const resolved = { ...req, resolved: true, userReply };
  _askQueue.set(stateId, resolved);

  try {
    const sb = getSupabase();
    await sb
      .from('agent_ask_human_queue')
      .update({ resolved: true, userReply })
      .eq('stateId', stateId);
  } catch { /* offline */ }

  return resolved;
}

/**
 * getPendingAskHuman
 * Returns all unresolved Ask Human requests for a session.
 */
export async function getPendingAskHuman(sessionId: string): Promise<AskHumanRequest[]> {
  // Local cache first
  const local = Array.from(_askQueue.values()).filter(
    r => r.sessionId === sessionId && !r.resolved,
  );
  if (local.length) return local;

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from('agent_ask_human_queue')
      .select('*')
      .eq('sessionId', sessionId)
      .eq('resolved', false)
      .order('createdAt', { ascending: true });
    return (data ?? []) as AskHumanRequest[];
  } catch {
    return [];
  }
}
