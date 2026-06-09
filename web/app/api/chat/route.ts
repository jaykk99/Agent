import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const SYSTEM_INSTRUCTION = `You are an AI coding assistant with **direct, live access** to GitHub repositories and a shell environment.

CRITICAL RULES:
- NEVER tell the user to "copy and paste" code or manually edit files. You have tools to do it yourself.
- NEVER say you "cannot directly access" repositories. You can — use list_github_directory, read_github_file, and write_github_file.
- When asked to edit or improve code, ACTUALLY do it: read the file, make the change, write it back.
- When exploring a repo, start with list_github_directory("") to see the root, then drill into relevant folders.
- Always read a file before writing it (to get the current SHA for updates).
- Use descriptive commit messages.
- After completing changes, tell the user exactly what files were modified and what changed.
- You can run shell commands (npm, git, etc.) via run_shell_command when useful.`;

const GITHUB_TOOLS = {
  functionDeclarations: [
    {
      name: 'list_github_directory',
      description: 'List files and folders in a GitHub repository directory. Use this to explore the repo structure before making changes.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in format owner/repo, e.g. jaykk99/Agent' },
          path: { type: 'string', description: 'Directory path. Use empty string for the root directory.' }
        },
        required: ['repo']
      }
    },
    {
      name: 'read_github_file',
      description: 'Read the full content of a specific file from a GitHub repository. Returns content and SHA (needed for updates).',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in format owner/repo' },
          path: { type: 'string', description: 'File path, e.g. "src/index.ts" or "README.md"' }
        },
        required: ['repo', 'path']
      }
    },
    {
      name: 'write_github_file',
      description: 'Create a new file or update an existing file in a GitHub repository. ALWAYS read the file first to get the SHA before updating. Never ask the user to do this manually.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in format owner/repo' },
          path: { type: 'string', description: 'File path to create or update' },
          content: { type: 'string', description: 'Complete new file content (entire file, not a diff)' },
          message: { type: 'string', description: 'Git commit message describing what was changed and why' },
          sha: { type: 'string', description: 'Current file SHA from read_github_file (required when updating existing file; omit only for brand new files)' },
          branch: { type: 'string', description: 'Branch to commit to, defaults to the repo default branch (usually main or master)' }
        },
        required: ['repo', 'path', 'content', 'message']
      }
    },
    {
      name: 'run_shell_command',
      description: 'Execute a shell command in the server environment. Useful for npm, yarn, git, or other CLI tools. Commands run in /tmp.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute, e.g. "npm --version" or "git --version"' }
        },
        required: ['command']
      }
    }
  ]
};

async function executeGithubFunction(name: string, args: Record<string, string>): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token && name !== 'run_shell_command') return 'Error: GITHUB_TOKEN is not configured on the server';

  try {
    if (name === 'list_github_directory') {
      const { repo, path = '' } = args;
      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'AIAgent' }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return `Error listing directory: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      if (Array.isArray(data)) {
        const lines = data.map((f: { name: string; type: string; size: number }) =>
          `${f.type === 'dir' ? '📁' : '📄'} ${f.name}${f.type === 'file' ? ` (${f.size} bytes)` : ''}`
        );
        return `Directory: /${path || ''}\n${lines.join('\n')}`;
      }
      return JSON.stringify(data);
    }

    if (name === 'read_github_file') {
      const { repo, path } = args;
      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'AIAgent' }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return `Error reading file: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      if (data.content) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return `path: ${data.path}\nsha: ${data.sha}\nsize: ${data.size} bytes\n\n---FILE CONTENT---\n${content}\n---END---`;
      }
      if (Array.isArray(data)) return `That path is a directory. Use list_github_directory instead.`;
      return 'File has no readable content';
    }

    if (name === 'write_github_file') {
      const { repo, path, content, message, sha, branch } = args;
      const body: Record<string, string> = {
        message,
        content: Buffer.from(content, 'utf-8').toString('base64')
      };
      if (sha) body.sha = sha;
      if (branch) body.branch = branch;

      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'AIAgent'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return `Error writing file: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      return `✅ ${sha ? 'Updated' : 'Created'} ${path} — commit: ${data.commit?.sha?.slice(0, 7)} — ${data.content?.html_url}`;
    }

    if (name === 'run_shell_command') {
      const { command } = args;
      const blocked = ['rm -rf /', 'sudo rm', 'mkfs', ':(){', 'chmod 777 /', '> /dev/sda'];
      for (const b of blocked) {
        if (command.includes(b)) return `Blocked: "${b}" is not permitted`;
      }
      const { stdout, stderr } = await execAsync(command, { timeout: 15000, cwd: '/tmp' });
      const out = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
      return out || '(command ran with no output)';
    }

    return `Unknown function: ${name}`;
  } catch (e) {
    return `Execution error: ${e instanceof Error ? e.message : 'Unknown error'}`;
  }
}

// Build Gemini-compatible tools array (search + function declarations can coexist)
function buildTools(useSearch: boolean) {
  const tools: object[] = [GITHUB_TOOLS];
  if (useSearch) tools.push({ google_search: {} });
  return tools;
}

async function callGemini(apiKey: string, model: string, contents: object[], useSearch: boolean) {
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents,
    tools: buildTools(useSearch),
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
  };

  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
}

export async function POST(req: NextRequest) {
  try {
    const { message, history, settings } = await req.json();

    const apiKey = settings?.is_custom_gemini_key_enabled && settings?.custom_gemini_api_key
      ? settings.custom_gemini_api_key
      : process.env.GEMINI_API_KEY;

    if (!apiKey) return NextResponse.json({ error: 'No Gemini API key configured' }, { status: 400 });

    const useSearch = !!settings?.enable_web_search;
    const requested = settings?.active_model_name || 'gemini-2.5-flash';
    const modelsToTry = [requested, ...FALLBACK_MODELS.filter(m => m !== requested)];

    // Build initial conversation history
    const baseContents: object[] = [
      ...(history || []).map((h: { role: string; text: string }) => ({
        role: h.role,
        parts: [{ text: h.text }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    let usedModel = requested;

    // Try models with fallback
    let geminiRes: Response | null = null;
    for (const model of modelsToTry) {
      const res = await callGemini(apiKey, model, baseContents, useSearch);
      if (res.ok) { geminiRes = res; usedModel = model; break; }
      const errText = await res.text();
      let errCode: number | undefined;
      try { errCode = JSON.parse(errText)?.error?.code; } catch { /* ignore */ }
      if (errCode !== 503 && errCode !== 429 && errCode !== 404) {
        return NextResponse.json({ error: errText }, { status: 500 });
      }
    }
    if (!geminiRes) return NextResponse.json({ error: 'All models unavailable' }, { status: 503 });

    // ── Function calling loop ──────────────────────────────────────────────
    let currentContents: object[] = [...baseContents];
    let currentRes = geminiRes;
    const MAX_TURNS = 12;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const geminiData = await currentRes.json();

      if (geminiData.error) {
        return NextResponse.json({ error: geminiData.error.message || 'Gemini error' }, { status: 500 });
      }

      const candidate = geminiData.candidates?.[0];
      const parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, string> } }> = candidate?.content?.parts || [];

      // Find function calls
      const fnCalls = parts.filter(p => p.functionCall);

      if (fnCalls.length === 0) {
        // Terminal turn — assemble final text
        const textParts = parts.filter(p => p.text).map(p => p.text!);
        let text = textParts.join('\n') || 'No response from model.';

        // Model fallback note
        if (usedModel !== requested) {
          text += `\n\n_(used ${usedModel} — ${requested} was temporarily unavailable)_`;
        }

        // Search grounding sources
        const groundingMeta = candidate?.groundingMetadata;
        if (groundingMeta?.groundingChunks?.length) {
          const sources = groundingMeta.groundingChunks
            .slice(0, 5)
            .map((c: { web?: { uri: string; title: string } }) => c.web ? `[${c.web.title || c.web.uri}](${c.web.uri})` : null)
            .filter(Boolean)
            .join(' · ');
          if (sources) text += `\n\n🔍 Sources: ${sources}`;
        }

        return NextResponse.json({ text });
      }

      // Execute all function calls in parallel
      const fnResults = await Promise.all(
        fnCalls.map(async (p) => {
          const fn = p.functionCall!;
          const result = await executeGithubFunction(fn.name, fn.args || {});
          return {
            functionResponse: {
              name: fn.name,
              response: { result }
            }
          };
        })
      );

      // Continue conversation with function results
      currentContents = [
        ...currentContents,
        { role: 'model', parts },
        { role: 'user', parts: fnResults }
      ];

      // Next Gemini turn
      currentRes = await callGemini(apiKey, usedModel, currentContents, useSearch);
      if (!currentRes.ok) {
        const err = await currentRes.text();
        return NextResponse.json({ error: err }, { status: 500 });
      }
    }

    return NextResponse.json({ error: 'Max function-call iterations reached' }, { status: 500 });

  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
