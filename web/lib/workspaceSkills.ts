/**
 * web/lib/workspaceSkills.ts
 *
 * Workspace-Level Custom Skills System
 * ──────────────────────────────────────────────────────────────────────────
 * Skills are static instruction sets that are automatically injected into
 * agent system prompts based on the current goal context.
 *
 * Capacity: 100 skills per workspace, max 10 attached to a single agent run.
 *
 * Skill types:
 *   design_system   — UI component guidelines, colour tokens, spacing rules
 *   copy_standards  — Tone of voice, naming conventions, terminology
 *   code_style      — Linting rules, import order, file naming
 *   data_safety     — PII handling, secret management, env var rules
 *   api_convention  — REST/GraphQL standards, error format, versioning
 *   custom          — User-defined instruction set
 */

import { getSupabase } from '@/lib/supabase';

export type SkillType =
  | 'design_system'
  | 'copy_standards'
  | 'code_style'
  | 'data_safety'
  | 'api_convention'
  | 'custom';

export interface WorkspaceSkill {
  id:           string;
  sessionId:    string;
  name:         string;
  type:         SkillType;
  /** The instruction text injected verbatim into agent system prompts */
  instruction:  string;
  /** Keywords that trigger this skill's automatic activation */
  triggers:     string[];
  /** Maximum number of concurrent activations across agents */
  maxInstances: number;
  enabled:      boolean;
  createdAt:    string;
  updatedAt:    string;
}

// ── Built-in default skills ──────────────────────────────────────────────────
export const DEFAULT_SKILLS: Omit<WorkspaceSkill, 'id' | 'sessionId' | 'createdAt' | 'updatedAt'>[] = [
  {
    name:         'Code Safety Guard',
    type:         'data_safety',
    instruction:  'NEVER hard-code API keys, tokens, or secrets. Always use environment variables prefixed with NEXT_PUBLIC_ for client-side and without prefix for server-side. Store secrets in .env.local only.',
    triggers:     ['api key', 'secret', 'token', 'password', 'credential'],
    maxInstances: 10,
    enabled:      true,
  },
  {
    name:         'TypeScript Strict',
    type:         'code_style',
    instruction:  'All new files must use TypeScript. Prefer explicit types over `any`. Use interface for object shapes, type for unions. Export types separately from implementations.',
    triggers:     ['typescript', 'javascript', '.ts', '.tsx', 'component'],
    maxInstances: 10,
    enabled:      true,
  },
  {
    name:         'Next.js API Convention',
    type:         'api_convention',
    instruction:  'API routes must export `runtime = "nodejs"` and `dynamic = "force-dynamic"`. Return NextResponse.json() for all responses. Include HTTP status codes. Validate all inputs before processing.',
    triggers:     ['api route', 'route.ts', 'endpoint', 'handler'],
    maxInstances: 10,
    enabled:      true,
  },
  {
    name:         'Error Handling Standard',
    type:         'code_style',
    instruction:  'Wrap all async operations in try/catch. Return structured errors: { error: string, code?: string }. Log errors server-side, never expose stack traces to clients.',
    triggers:     ['error', 'exception', 'catch', 'try'],
    maxInstances: 10,
    enabled:      true,
  },
  {
    name:         'Tailwind UI Standard',
    type:         'design_system',
    instruction:  'Use Tailwind CSS utility classes. Dark theme: bg-gray-950/900/800 surfaces, text-gray-100/300/500 text hierarchy. Accent: blue-500/600. Interactive states: hover:bg-gray-700, focus:ring-2 focus:ring-blue-500. Border: border-gray-700.',
    triggers:     ['ui', 'component', 'style', 'tailwind', 'design', 'layout'],
    maxInstances: 10,
    enabled:      true,
  },
];

// ── In-process cache ─────────────────────────────────────────────────────────
const _skillCache: Map<string, WorkspaceSkill[]> = new Map();

// ── CRUD Operations ──────────────────────────────────────────────────────────

export async function listSkills(sessionId: string): Promise<WorkspaceSkill[]> {
  if (_skillCache.has(sessionId)) return _skillCache.get(sessionId)!;

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from('workspace_skills')
      .select('*')
      .eq('sessionId', sessionId)
      .eq('enabled', true)
      .order('createdAt', { ascending: true });

    const skills = (data ?? []) as WorkspaceSkill[];
    _skillCache.set(sessionId, skills);
    return skills;
  } catch {
    return seedDefaultSkills(sessionId);
  }
}

export async function createSkill(
  sessionId: string,
  input: Omit<WorkspaceSkill, 'id' | 'sessionId' | 'createdAt' | 'updatedAt'>,
): Promise<WorkspaceSkill> {
  const existing = await listSkills(sessionId);
  if (existing.length >= 100) {
    throw new Error('Workspace skill limit (100) reached. Remove a skill before adding a new one.');
  }

  const now = new Date().toISOString();
  const skill: WorkspaceSkill = {
    ...input,
    id:        `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const sb = getSupabase();
    await sb.from('workspace_skills').insert([skill]);
  } catch { /* offline */ }

  const cached = _skillCache.get(sessionId) ?? [];
  _skillCache.set(sessionId, [...cached, skill]);
  return skill;
}

export async function deleteSkill(sessionId: string, skillId: string): Promise<void> {
  try {
    const sb = getSupabase();
    await sb.from('workspace_skills').delete().eq('id', skillId).eq('sessionId', sessionId);
  } catch { /* offline */ }

  const cached = _skillCache.get(sessionId) ?? [];
  _skillCache.set(sessionId, cached.filter(s => s.id !== skillId));
}

/** Seed defaults if no skills exist for this session yet */
function seedDefaultSkills(sessionId: string): WorkspaceSkill[] {
  const now = new Date().toISOString();
  return DEFAULT_SKILLS.map((s, i) => ({
    ...s,
    id:        `default_${i}`,
    sessionId,
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * selectActiveSkills
 * Returns up to 10 skills whose triggers match the current context.
 * Used by the orchestrator to build role-specific system prompts.
 */
export async function selectActiveSkills(
  sessionId: string,
  context: string,
): Promise<WorkspaceSkill[]> {
  const all = await listSkills(sessionId);
  const lower = context.toLowerCase();

  const scored = all
    .filter(s => s.enabled)
    .map(s => ({
      skill: s,
      score: s.triggers.filter(t => lower.includes(t.toLowerCase())).length,
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Always include data_safety skills regardless of context score
  const safetySkills = all.filter(s => s.type === 'data_safety' && s.enabled);
  const contextSkills = scored.map(x => x.skill).filter(s => s.type !== 'data_safety');

  return [...safetySkills, ...contextSkills].slice(0, 10);
}

/**
 * buildSkillsBlock
 * Formats selected skills as a system-prompt instruction block.
 */
export function buildSkillsBlock(skills: WorkspaceSkill[]): string {
  if (!skills.length) return '';
  return [
    '── Workspace Skills (follow strictly) ──',
    ...skills.map(s => `[${s.type.toUpperCase()}] ${s.name}:\n${s.instruction}`),
  ].join('\n\n');
}
