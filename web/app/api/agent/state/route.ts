/**
 * web/app/api/agent/state/route.ts
 *
 * Procedural State Serialisation Endpoints
 * ──────────────────────────────────────────────────────────────────────────
 * Allows the chat agent to save, load, and update its execution state,
 * enabling multi-session continuity and cross-agent state sharing.
 *
 * POST   /api/agent/state         — create a new state
 * GET    /api/agent/state?id=...  — load a state by ID
 * PATCH  /api/agent/state         — update a state (with memory decay)
 * DELETE /api/agent/state?id=...  — delete a state
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createState,
  saveState,
  loadState,
  updateState,
  type MemoryScope,
} from '@/lib/agentState';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

// GET — load state
export async function GET(req: NextRequest) {
  const stateId  = req.nextUrl.searchParams.get('id');
  const sessionId = req.nextUrl.searchParams.get('sessionId');

  if (stateId) {
    const state = await loadState(stateId);
    if (!state) return NextResponse.json({ error: 'State not found' }, { status: 404 });
    // Strip resolved secrets from response
    const { resolvedVars: _, ...safe } = state;
    return NextResponse.json(safe);
  }

  if (sessionId) {
    // List all states for a session
    try {
      const sb = getSupabase();
      const { data } = await sb
        .from('agent_execution_states')
        .select('stateId, activeRole, goal, stepIndex, updatedAt, scope')
        .eq('sessionId', sessionId)
        .order('updatedAt', { ascending: false })
        .limit(20);
      return NextResponse.json(data ?? []);
    } catch {
      return NextResponse.json([]);
    }
  }

  return NextResponse.json({ error: 'id or sessionId required' }, { status: 400 });
}

// POST — create new state
export async function POST(req: NextRequest) {
  let body: { sessionId?: string; goal?: string; scope?: MemoryScope };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { sessionId, goal, scope } = body;
  if (!sessionId || !goal) {
    return NextResponse.json({ error: 'sessionId and goal are required' }, { status: 400 });
  }

  const state = createState(sessionId, goal, scope ?? 'session');
  await saveState(state);
  const { resolvedVars: _, ...safe } = state;
  return NextResponse.json(safe, { status: 201 });
}

// PATCH — update state with memory decay
export async function PATCH(req: NextRequest) {
  let body: { stateId?: string; patch?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { stateId, patch } = body;
  if (!stateId || !patch) {
    return NextResponse.json({ error: 'stateId and patch are required' }, { status: 400 });
  }

  const updated = await updateState(stateId, patch as Parameters<typeof updateState>[1]);
  if (!updated) return NextResponse.json({ error: 'State not found' }, { status: 404 });
  const { resolvedVars: _, ...safe } = updated;
  return NextResponse.json(safe);
}

// DELETE — remove state
export async function DELETE(req: NextRequest) {
  const stateId = req.nextUrl.searchParams.get('id');
  if (!stateId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  try {
    const sb = getSupabase();
    await sb.from('agent_execution_states').delete().eq('stateId', stateId);
  } catch { /* offline */ }

  return NextResponse.json({ ok: true });
}
