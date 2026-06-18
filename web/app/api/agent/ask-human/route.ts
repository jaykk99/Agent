/**
 * web/app/api/agent/ask-human/route.ts
 *
 * Interactive "Ask Human" Flow — HITL Pause / Resume Queue
 * ──────────────────────────────────────────────────────────────────────────
 * When an agent gets stuck (compilation error, layout bug, missing info),
 * rather than burning tokens in a recursive loop, it:
 *   1. Serialises the workspace state (via agentState.ts)
 *   2. Posts an Ask Human request with the exact error log + file location
 *   3. Waits for user feedback
 *   4. Resumes from the exact step index when the user replies
 *
 * POST /api/agent/ask-human         — agent pauses and raises a question
 * GET  /api/agent/ask-human?session — frontend polls for pending questions
 * PUT  /api/agent/ask-human         — user provides reply, resumes agent
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  pauseForHuman,
  resolveHumanRequest,
  getPendingAskHuman,
  loadState,
} from '@/lib/agentState';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

// GET — poll for pending human questions
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('session') ?? '';
  if (!sessionId) {
    return NextResponse.json({ error: 'session param required' }, { status: 400 });
  }
  const pending = await getPendingAskHuman(sessionId);
  return NextResponse.json({ pending, count: pending.length });
}

// POST — agent raises a HITL request
export async function POST(req: NextRequest) {
  let body: {
    stateId?:  string;
    reason?:   string;
    filePath?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { stateId, reason, filePath } = body;
  if (!stateId || !reason) {
    return NextResponse.json({ error: 'stateId and reason are required' }, { status: 400 });
  }

  const state = await loadState(stateId);
  if (!state) {
    return NextResponse.json({ error: 'Execution state not found' }, { status: 404 });
  }

  const req_ = await pauseForHuman(state, reason, filePath);
  return NextResponse.json({
    queued:     true,
    requestId:  req_.stateId,
    resumeStep: req_.resumeStep,
    message:    `Execution paused at step ${req_.resumeStep}. Waiting for user input.`,
  }, { status: 202 });
}

// PUT — user provides reply and resumes the agent
export async function PUT(req: NextRequest) {
  let body: { stateId?: string; reply?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { stateId, reply } = body;
  if (!stateId || !reply) {
    return NextResponse.json({ error: 'stateId and reply are required' }, { status: 400 });
  }

  const resolved = await resolveHumanRequest(stateId, reply);
  if (!resolved) {
    return NextResponse.json({ error: 'Request not found or already resolved' }, { status: 404 });
  }

  return NextResponse.json({
    resolved:   true,
    stateId:    resolved.stateId,
    resumeStep: resolved.resumeStep,
    message:    `Execution will resume from step ${resolved.resumeStep} with user feedback.`,
  });
}
