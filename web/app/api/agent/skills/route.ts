/**
 * web/app/api/agent/skills/route.ts
 *
 * Workspace Skills CRUD Endpoints
 * ──────────────────────────────────────────────────────────────────────────
 * GET    /api/agent/skills?sessionId=...  — list all skills
 * POST   /api/agent/skills               — create a new skill
 * DELETE /api/agent/skills?id=...&sessionId=... — delete a skill
 * POST   /api/agent/skills/activate      — select active skills for a context
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listSkills,
  createSkill,
  deleteSkill,
  selectActiveSkills,
  buildSkillsBlock,
  type SkillType,
} from '@/lib/workspaceSkills';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId') ?? '';
  if (!sessionId) return NextResponse.json([], { status: 400 });
  const skills = await listSkills(sessionId);
  return NextResponse.json(skills);
}

export async function POST(req: NextRequest) {
  let body: {
    sessionId?:   string;
    name?:        string;
    type?:        SkillType;
    instruction?: string;
    triggers?:    string[];
    context?:     string; // for activate action
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Activate action: select matching skills for a context
  if (body.context && body.sessionId) {
    const skills = await selectActiveSkills(body.sessionId, body.context);
    return NextResponse.json({
      skills,
      block: buildSkillsBlock(skills),
      count: skills.length,
    });
  }

  // Create action
  const { sessionId, name, type, instruction, triggers } = body;
  if (!sessionId || !name || !type || !instruction) {
    return NextResponse.json(
      { error: 'sessionId, name, type, and instruction are required' },
      { status: 400 },
    );
  }

  try {
    const skill = await createSkill(sessionId, {
      name,
      type,
      instruction,
      triggers:     triggers ?? [],
      maxInstances: 10,
      enabled:      true,
    });
    return NextResponse.json(skill, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to create skill';
    return NextResponse.json({ error: msg }, { status: 422 });
  }
}

export async function DELETE(req: NextRequest) {
  const skillId   = req.nextUrl.searchParams.get('id') ?? '';
  const sessionId = req.nextUrl.searchParams.get('sessionId') ?? '';
  if (!skillId || !sessionId) {
    return NextResponse.json({ error: 'id and sessionId required' }, { status: 400 });
  }
  await deleteSkill(sessionId, skillId);
  return NextResponse.json({ ok: true });
}
