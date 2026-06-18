/**
 * web/app/api/agent/supervisor/route.ts
 *
 * Supervisor Routing Endpoint
 * ──────────────────────────────────────────────────────────────────────────
 * Exposes the multi-agent supervisor router as an API endpoint.
 *
 * POST /api/agent/supervisor
 *   Body: ExecutionContext
 *   Returns: RoutingDecision + agent system prompt fragment
 *
 * GET /api/agent/supervisor
 *   Returns: { agents: AgentNode[] } — registry of all specialised agents
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  supervisorRoute,
  buildAgentSystemPrompt,
  AGENT_NODES,
  type ExecutionContext,
} from '@/lib/orchestrator';
import { selectActiveSkills, buildSkillsBlock } from '@/lib/workspaceSkills';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ agents: AGENT_NODES });
}

export async function POST(req: NextRequest) {
  let ctx: ExecutionContext;
  try {
    ctx = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!ctx.sessionId || !ctx.goal) {
    return NextResponse.json(
      { error: 'sessionId and goal are required' },
      { status: 400 },
    );
  }

  const decision = supervisorRoute(ctx);

  // Load matching workspace skills for this context
  const contextText = `${ctx.goal} ${ctx.currentStep}`;
  const skills = await selectActiveSkills(ctx.sessionId, contextText);
  const skillNames = skills.map(s => s.name);
  const systemPromptFragment = buildAgentSystemPrompt(decision.role, skillNames);
  const skillsBlock = buildSkillsBlock(skills);

  return NextResponse.json({
    decision,
    systemPromptFragment,
    skillsBlock,
    activeSkillCount: skills.length,
  });
}
