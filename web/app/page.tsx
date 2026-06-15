'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send, Bot, Plug, Settings, Github, Trash2, Plus, Copy, Check,
  ChevronDown, ChevronUp, Loader2, X, AlertCircle, LogOut,
  Globe, FolderOpen, ExternalLink, Zap, Terminal, Search,
  Database, Cloud, Code2, GitBranch, Eye
} from 'lucide-react';

/* ─── Types ─────────────────────────────────────────── */
interface Message {
  id?: number;
  text: string;
  is_user: boolean;
  status?: string;
  model?: string;
  tool_calls?: ToolCallRecord[];
  api_call_url?: string;
  api_call_response?: string;
  api_call_status?: number;
}
interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}
interface ApiTemplate {
  id?: number;
  name: string;
  url: string;
  method: string;
  headers_json: string;
  params_json: string;
  body_template?: string;
  description: string;
}
interface ServiceConnection { id?: number; service_name: string; api_key: string; }
interface AppSettings {
  is_custom_gemini_key_enabled: boolean;
  custom_gemini_api_key: string;
  active_model_name: string;
  is_custom_model_enabled: boolean;
  custom_model_endpoint: string;
  custom_model_api_key: string;
  custom_model_name: string;
  hf_api_key: string;
  github_token: string;
  github_username: string;
  github_avatar_url: string;
  is_github_connected: boolean;
  is_google_connected: boolean;
  google_user_email: string;
  google_user_name: string;
  google_avatar_url: string;
  enable_web_search: boolean;
  supabase_access_token: string;
  supabase_url: string;
  supabase_username: string;
  is_supabase_connected: boolean;
  vercel_access_token: string;
  vercel_username: string;
  is_vercel_connected: boolean;
}
interface GitHubRepo { id: number; name: string; full_name: string; description: string; html_url: string; language: string; stargazers_count: number; updated_at: string; }

const DEFAULT_SETTINGS: AppSettings = {
  is_custom_gemini_key_enabled: false, custom_gemini_api_key: '',
  active_model_name: 'gemini-2.5-flash', is_custom_model_enabled: false,
  custom_model_endpoint: '', custom_model_api_key: '', custom_model_name: '',
  hf_api_key: '',
  github_token: '', github_username: '', github_avatar_url: '', is_github_connected: false,
  is_google_connected: false, google_user_email: '', google_user_name: '', google_avatar_url: '',
  enable_web_search: false,
  supabase_access_token: '', supabase_url: '', supabase_username: '', is_supabase_connected: false,
  vercel_access_token: '', vercel_username: '', is_vercel_connected: false,
};

type Tab = 'chat' | 'connectors' | 'model_settings' | 'integrations';

/* ─── Simple Markdown renderer ──────────────────────── */
function renderMarkdown(text: string): string {
  return text
    // Code blocks
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre class="bg-gray-900 border border-gray-700 rounded-lg p-3 my-2 overflow-x-auto text-xs font-mono text-green-300 whitespace-pre">${escHtml(code.trim())}</pre>`)
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="bg-gray-800 text-indigo-300 px-1 py-0.5 rounded text-xs font-mono">$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-white font-semibold">$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em class="text-gray-300">$1</em>')
    // Headers
    .replace(/^### (.+)$/gm, '<h3 class="text-white font-semibold text-sm mt-3 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-white font-bold text-base mt-4 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-white font-bold text-lg mt-4 mb-2">$1</h1>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-indigo-400 underline hover:text-indigo-300">$1</a>')
    // Checkboxes
    .replace(/^- \[x\] (.+)$/gm, '<div class="flex items-start gap-2 my-0.5"><span class="text-green-400 mt-0.5">✅</span><span>$1</span></div>')
    .replace(/^- \[ \] (.+)$/gm, '<div class="flex items-start gap-2 my-0.5"><span class="text-gray-500 mt-0.5">☐</span><span>$1</span></div>')
    // Unordered lists
    .replace(/^[-*] (.+)$/gm, '<div class="flex items-start gap-2 my-0.5 pl-2"><span class="text-indigo-400 mt-1.5 text-xs">•</span><span>$1</span></div>')
    // Ordered lists
    .replace(/^(\d+)\. (.+)$/gm, '<div class="flex items-start gap-2 my-0.5 pl-2"><span class="text-indigo-400 text-xs min-w-[1rem]">$1.</span><span>$2</span></div>')
    // Horizontal rule
    .replace(/^---$/gm, '<hr class="border-gray-700 my-3"/>')
    // Line breaks
    .replace(/\n\n/g, '</p><p class="mt-2">')
    .replace(/\n/g, '<br/>');
}

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ─── Tool Call Badge ───────────────────────────────── */
function ToolCallBadge({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const icons: Record<string, React.ReactNode> = {
    read_github_file: <Code2 size={11}/>,
    write_github_file: <GitBranch size={11}/>,
    list_github_directory: <FolderOpen size={11}/>,
    search_github_code: <Search size={11}/>,
    mcp_fetch_url: <Globe size={11}/>,
    query_supabase: <Database size={11}/>,
    list_vercel_projects: <Cloud size={11}/>,
    run_cli: <Terminal size={11}/>,
    run_shell_command: <Terminal size={11}/>,
  };
  const icon = icons[call.name] || <Zap size={11}/>;
  const label = call.name.replace(/_/g, ' ');

  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2 py-1 bg-gray-800/80 border border-gray-700/60 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-all"
      >
        <span className="text-indigo-400">{icon}</span>
        <span className="font-mono">{label}</span>
        {call.args && Object.keys(call.args).length > 0 && (
          <span className="text-gray-600 truncate max-w-[200px]">
            {Object.entries(call.args).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(', ')}
          </span>
        )}
        {open ? <ChevronUp size={10}/> : <ChevronDown size={10}/>}
      </button>
      {open && call.result && (
        <div className="mt-1 ml-4 p-2 bg-gray-900 border border-gray-700/40 rounded-lg text-xs text-gray-400 font-mono max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
          {call.result.slice(0, 2000)}
          {call.result.length > 2000 && <span className="text-gray-600">…(truncated)</span>}
        </div>
      )}
    </div>
  );
}

/* ─── Thinking Indicator ────────────────────────────── */
function ThinkingDots({ status }: { status: string }) {
  return (
    <div className="flex justify-start mb-3">
      <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center mr-2 flex-shrink-0 mt-1 animate-pulse">
        <Bot size={16}/>
      </div>
      <div className="bg-gray-800/80 border border-gray-700/40 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-2">
        <Loader2 size={14} className="animate-spin text-indigo-400"/>
        <span className="text-sm text-gray-400">{status}</span>
        <span className="flex gap-0.5">
          {[0,1,2].map(i => (
            <span key={i} className="w-1 h-1 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }}/>
          ))}
        </span>
      </div>
    </div>
  );
}

/* ─── Message Renderer ──────────────────────────────── */
function MessageBubble({ msg, idx, onDelete, onCopy, copied }: {
  msg: Message; idx: number;
  onDelete: (id?: number) => void;
  onCopy: (text: string, key: string) => void;
  copied: string | null;
}) {
  const key = msg.id ?? idx;
  const [showTools, setShowTools] = useState(false);
  const hasTools = msg.tool_calls && msg.tool_calls.length > 0;

  return (
    <div className={`flex ${msg.is_user ? 'justify-end' : 'justify-start'} mb-4 group`}>
      {!msg.is_user && (
        <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center mr-2 flex-shrink-0 mt-1 shadow-lg shadow-indigo-600/20">
          <Bot size={16}/>
        </div>
      )}
      <div className={`max-w-[85%] ${msg.is_user ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* Tool calls (collapsed by default) */}
        {hasTools && (
          <div className="mb-1 w-full">
            <button
              onClick={() => setShowTools(o => !o)}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 mb-1"
            >
              <Zap size={11} className="text-indigo-500"/>
              {msg.tool_calls!.length} tool call{msg.tool_calls!.length !== 1 ? 's' : ''}
              {showTools ? <ChevronUp size={10}/> : <ChevronDown size={10}/>}
            </button>
            {showTools && msg.tool_calls!.map((tc, i) => (
              <ToolCallBadge key={i} call={tc}/>
            ))}
          </div>
        )}
        {/* Main message bubble */}
        <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed break-words w-full ${
          msg.is_user
            ? 'bg-indigo-600 text-white rounded-tr-sm'
            : 'bg-gray-800/60 border border-gray-700/40 text-gray-100 rounded-tl-sm'
        } ${msg.status === 'ERROR' ? 'border-red-500/50 bg-red-900/20' : ''}`}>
          {msg.status === 'ERROR' && <AlertCircle size={14} className="inline mr-1 text-red-400"/>}
          {msg.is_user ? (
            <span className="whitespace-pre-wrap">{msg.text}</span>
          ) : (
            <div
              className="prose-sm prose-invert"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }}
            />
          )}
          {msg.model && (
            <div className="mt-2 pt-2 border-t border-gray-700/40 text-xs text-gray-500 font-mono">
              {msg.model}
            </div>
          )}
        </div>
        {/* Actions */}
        <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => onCopy(msg.text, `msg-${key}`)} className="text-gray-600 hover:text-gray-400 p-0.5 rounded">
            {copied === `msg-${key}` ? <Check size={12} className="text-green-400"/> : <Copy size={12}/>}
          </button>
          {!msg.is_user && (
            <button onClick={() => onDelete(msg.id)} className="text-gray-600 hover:text-red-400 p-0.5 rounded">
              <Trash2 size={12}/>
            </button>
          )}
        </div>
      </div>
      {msg.is_user && (
        <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center ml-2 flex-shrink-0 mt-1">
          <span className="text-xs font-bold text-gray-300">U</span>
        </div>
      )}
    </div>
  );
}

/* ─── Starter prompts ───────────────────────────────── */
const STARTERS = [
  { icon: <Github size={14}/>, text: 'Explore my GitHub repos and tell me what you find', label: 'Explore repos' },
  { icon: <Code2 size={14}/>, text: 'Read the main files in jaykk99/Agent and find any bugs or errors', label: 'Audit code' },
  { icon: <GitBranch size={14}/>, text: 'What changed in jaykk99/Agent in the last 5 commits?', label: 'Recent changes' },
  { icon: <Search size={14}/>, text: 'Search jaykk99/Agent for any TODO or FIXME comments', label: 'Find TODOs' },
  { icon: <Globe size={14}/>, text: 'Fetch https://api.github.com/zen and tell me what it says', label: 'Test fetch' },
  { icon: <Zap size={14}/>, text: 'What tools do you have and what can you do?', label: 'Your capabilities' },
];

/* ─── Main Component ─────────────────────────────────── */
export default function Home() {
  const [tab, setTab] = useState<Tab>('chat');
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingStatus, setThinkingStatus] = useState('Thinking…');
  const [connectors, setConnectors] = useState<ApiTemplate[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [serviceConns, setServiceConns] = useState<ServiceConnection[]>([]);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showAddConnector, setShowAddConnector] = useState(false);
  const [showAddService, setShowAddService] = useState(false);
  const [attachedRepo, setAttachedRepo] = useState<{ full_name: string; tree: string } | null>(null);
  const [connectError, setConnectError] = useState('');
  const [signedInUser, setSignedInUser] = useState<{ email: string; name: string; avatar: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* Init session */
  useEffect(() => {
    let sid = localStorage.getItem('agent_session_id');
    if (!sid) { sid = crypto.randomUUID(); localStorage.setItem('agent_session_id', sid); }
    setSessionId(sid);
  }, []);

  /* Load data */
  useEffect(() => {
    if (!sessionId) return;
    fetchMessages();
    fetchConnectors();
    fetchServiceConns();
    (async () => {
      let current = settings;
      try {
        const data = await api(`/api/db/settings?session_id=${sessionId}`);
        if (data) { current = data as AppSettings; setSettings(current); }
      } catch { /* use defaults */ }

      const params = new URLSearchParams(window.location.search);
      const oauthError = params.get('error');
      const ghToken  = params.get('gh_token');
      const ghUser   = params.get('gh_user');
      const ghAvatar = params.get('gh_avatar');
      const ghEmail  = params.get('gh_email');
      const sbToken  = params.get('sb_token');
      const sbUser   = params.get('sb_user');
      const vrToken  = params.get('vr_token');
      const vrUser   = params.get('vr_user');

      if (oauthError || ghToken || sbToken || vrToken) window.history.replaceState({}, '', '/');
      if (oauthError) { setConnectError(`OAuth failed: ${oauthError}`); setTab('integrations'); return; }

      let merged: AppSettings | null = null;
      if (ghToken && ghUser) {
        merged = { ...current, github_token: ghToken, github_username: ghUser, github_avatar_url: ghAvatar || '', is_github_connected: true };
        if (ghUser) setSignedInUser({ email: ghEmail || '', name: ghUser, avatar: ghAvatar || '' });
        setTab('chat');
      } else if (sbToken && sbUser) {
        merged = { ...current, supabase_access_token: sbToken, supabase_username: sbUser, is_supabase_connected: true };
        setTab('chat');
      } else if (vrToken && vrUser) {
        merged = { ...current, vercel_access_token: vrToken, vercel_username: vrUser, is_vercel_connected: true };
        setTab('chat');
      }
      if (merged) { setSettings(merged); await saveSettings(merged); }

      // Supabase browser auth
      const sbUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const sbAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (sbUrl && sbAnon) {
        const { createClient } = await import('@supabase/supabase-js');
        const sb = createClient(sbUrl, sbAnon);
        const { data: { session } } = await sb.auth.getSession();
        if (session?.user) {
          setSignedInUser({
            email: session.user.email || '',
            name: session.user.user_metadata?.full_name || session.user.email || '',
            avatar: session.user.user_metadata?.avatar_url || '',
          });
        }
        sb.auth.onAuthStateChange(async (_event, sess) => {
          if (sess?.user) {
            const u = sess.user;
            setSignedInUser({ email: u.email || '', name: u.user_metadata?.full_name || u.email || '', avatar: u.user_metadata?.avatar_url || '' });
          } else {
            setSignedInUser(null);
          }
        });
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, isThinking]);

  /* API helper */
  const api = useCallback(async (path: string, opts?: RequestInit) => {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...opts?.headers } });
    if (!res.ok) {
      const body = await res.text();
      let msg = body;
      try { const j = JSON.parse(body); msg = j?.error ?? j?.message ?? body; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }, []);

  const loadSettings = useCallback(async () => {
    try { return (await api(`/api/db/settings?session_id=${sessionId}`)) as AppSettings; } catch { return DEFAULT_SETTINGS; }
  }, [api, sessionId]);

  const saveSettings = useCallback(async (s: AppSettings) => {
    setSettings(s);
    try { await api('/api/db/settings', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...s }) }); } catch { /* ignore */ }
  }, [api, sessionId]);

  const fetchMessages = useCallback(async () => {
    try {
      const data = await api(`/api/db/messages?session_id=${sessionId}`) as Message[];
      if (Array.isArray(data)) setMessages(data);
    } catch { /* ignore */ }
  }, [api, sessionId]);

  const fetchConnectors = useCallback(async () => {
    try {
      const data = await api(`/api/db/connectors?session_id=${sessionId}`) as ApiTemplate[];
      if (Array.isArray(data)) setConnectors(data);
    } catch { /* ignore */ }
  }, [api, sessionId]);

  const fetchServiceConns = useCallback(async () => {
    try {
      const data = await api(`/api/db/service-connections?session_id=${sessionId}`) as ServiceConnection[];
      if (Array.isArray(data)) setServiceConns(data);
    } catch { /* ignore */ }
  }, [api, sessionId]);

  const fetchGithubRepos = useCallback(async () => {
    if (!settings.github_token) return;
    setGithubLoading(true);
    try {
      const data = await api(`/api/github/repos?token=${encodeURIComponent(settings.github_token)}`) as GitHubRepo[];
      if (Array.isArray(data)) setGithubRepos(data);
    } catch { /* ignore */ } finally { setGithubLoading(false); }
  }, [api, settings.github_token]);

  /* ── Send message ── */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isThinking) return;
    setInput('');
    setIsThinking(true);
    setThinkingStatus('Thinking…');

    const userMsg: Message = { text, is_user: true, status: 'SUCCESS' };
    setMessages(prev => [...prev, userMsg]);
    await api('/api/db/messages', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...userMsg }) }).catch(() => {});

    try {
      // Check for API URL pattern
      const urlMatch = text.match(/https?:\/\/[^\s]+/);
      const methodMatch = text.match(/^(GET|POST|PUT|PATCH|DELETE)\s+/i);
      const isApiCall = urlMatch && (methodMatch || text.startsWith('http'));

      if (isApiCall && !text.toLowerCase().includes('fetch') && !text.toLowerCase().includes('check')) {
        setThinkingStatus('Calling API…');
        const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';
        const apiResp = await api('/api/execute-api', {
          method: 'POST',
          body: JSON.stringify({ url: urlMatch![0], method, headers: {}, params: {}, body: '' }),
        }) as { status_code: number; body: string };
        const aiText = `API Response (${apiResp.status_code}):\n\`\`\`json\n${JSON.stringify(JSON.parse(apiResp.body || '{}'), null, 2)}\n\`\`\``;
        const aiMsg: Message = { text: aiText, is_user: false, status: 'SUCCESS', api_call_url: urlMatch![0], api_call_response: apiResp.body };
        setMessages(prev => [...prev, aiMsg]);
        await api('/api/db/messages', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...aiMsg }) }).catch(() => {});
        return;
      }

      // Normal agent request
      const history = messages.slice(-20).map(m => ({ role: m.is_user ? 'user' : 'model', text: m.text }));
      const messageWithContext = attachedRepo
        ? `[Repo context: ${attachedRepo.full_name}]\n${attachedRepo.tree}\n\n---\n${text}`
        : text;

      setThinkingStatus('Working…');

      // ── Streaming fetch with live tool-call status updates ──────────────
      const chatRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageWithContext, history, session_id: sessionId, settings }),
      });

      // Non-streaming path (catch redirect/error before reading body)
      if (!chatRes.ok && chatRes.status !== 200) {
        const errText = await chatRes.text();
        let errMsg2 = errText;
        try { errMsg2 = JSON.parse(errText)?.error ?? errText; } catch { /* ignore */ }
        throw new Error(errMsg2);
      }

      const contentType = chatRes.headers.get('content-type') || '';
      let resp: { text?: string; error?: string; model?: string; tool_calls?: ToolCallRecord[]; detected_keys?: Array<{ field: string; value: string }> };

      if (contentType.includes('text/event-stream')) {
        // ── SSE streaming path ──────────────────────────────────────────
        const reader = chatRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const toolCallsAccum: ToolCallRecord[] = [];
        let finalText = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines2 = buffer.split('
');
          buffer = lines2.pop() || '';
          for (const line of lines2) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (raw === '[DONE]') break;
            try {
              const chunk = JSON.parse(raw);
              if (chunk.type === 'tool_start') {
                setThinkingStatus(`🔧 ${chunk.tool || chunk.name || 'tool'}…`);
                toolCallsAccum.push({ name: chunk.tool || chunk.name, args: chunk.args || {}, result: '' });
              } else if (chunk.type === 'tool_result') {
                const last = toolCallsAccum[toolCallsAccum.length - 1];
                if (last) last.result = chunk.result || '';
                setThinkingStatus(`✓ ${chunk.tool || ''} — thinking…`);
              } else if (chunk.type === 'done' || chunk.text) {
                finalText = chunk.text || finalText;
              }
            } catch { /* ignore malformed chunk */ }
          }
        }
        resp = { text: finalText, tool_calls: toolCallsAccum };
      } else {
        // ── Standard JSON path ─────────────────────────────────────────
        resp = await chatRes.json();
      }

      // Handle auto-detected keys
      if (resp.detected_keys?.length) {
        const updated = { ...settings };
        for (const { field, value } of resp.detected_keys) {
          (updated as unknown as Record<string, string>)[field] = value;
          if (field === 'github_token') updated.is_github_connected = true;
          if (field === 'vercel_access_token') updated.is_vercel_connected = true;
          if (field === 'custom_gemini_api_key') updated.is_custom_gemini_key_enabled = true;
        }
        await saveSettings(updated);
      }

      const aiText = resp.text || resp.error || 'No response.';
      const aiMsg: Message = {
        text: aiText,
        is_user: false,
        status: resp.error ? 'ERROR' : 'SUCCESS',
        model: resp.model,
        tool_calls: resp.tool_calls || [],
      };
      setMessages(prev => [...prev, aiMsg]);
      await api('/api/db/messages', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...aiMsg }) }).catch(() => {});

    } catch (e: unknown) {
      const errText = e instanceof Error ? e.message : 'Error sending message.';
      const errMsg: Message = { text: `Error: ${errText}`, is_user: false, status: 'ERROR' };
      setMessages(prev => [...prev, errMsg]);
      await api('/api/db/messages', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...errMsg }) }).catch(() => {});
    } finally {
      setIsThinking(false);
      setThinkingStatus('Thinking…');
    }
  }, [input, isThinking, sessionId, messages, settings, api, saveSettings, attachedRepo]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const copyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const deleteMessage = async (id?: number) => {
    if (!id) return;
    await api(`/api/db/messages?id=${id}`, { method: 'DELETE' }).catch(() => {});
    setMessages(prev => prev.filter(m => m.id !== id));
  };

  const clearChat = async () => {
    if (!sessionId) return;
    await api(`/api/db/messages?session_id=${sessionId}&all=true`, { method: 'DELETE' }).catch(() => {});
    setMessages([]);
  };

  /* ── Connected integrations badge ── */
  const connectedBadges = [
    settings.is_github_connected && settings.github_username && { label: settings.github_username, icon: <Github size={10}/>, color: 'text-gray-300 bg-gray-800 border-gray-700' },
    settings.is_supabase_connected && { label: 'Supabase', icon: <Database size={10}/>, color: 'text-green-300 bg-green-900/30 border-green-700/40' },
    settings.is_vercel_connected && { label: 'Vercel', icon: <Cloud size={10}/>, color: 'text-blue-300 bg-blue-900/30 border-blue-700/40' },
  ].filter(Boolean) as Array<{ label: string; icon: React.ReactNode; color: string }>;

  /* ── Tabs ── */
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'chat', label: 'Agent', icon: <Zap size={16}/> },
    { id: 'connectors', label: 'APIs', icon: <Plug size={16}/> },
    { id: 'model_settings', label: 'Model', icon: <Settings size={16}/> },
    { id: 'integrations', label: 'Connect', icon: <Github size={16}/> },
  ];

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800/60 bg-gray-950/95 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-600/30">
            <Zap size={16} className="text-white"/>
          </div>
          <div>
            <span className="font-bold text-white text-sm">AI Agent</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              {connectedBadges.map(b => (
                <span key={b.label} className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${b.color}`}>
                  {b.icon}{b.label}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {signedInUser && (
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              {signedInUser.avatar && <img src={signedInUser.avatar} className="w-5 h-5 rounded-full" alt=""/>}
              <span className="hidden sm:block">{signedInUser.name}</span>
            </div>
          )}
          {tab === 'chat' && messages.length > 0 && (
            <button onClick={clearChat} className="text-xs text-gray-600 hover:text-gray-400 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-gray-800 transition-colors">
              <Trash2 size={12}/> Clear
            </button>
          )}
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex border-b border-gray-800/60 bg-gray-950/95">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-all ${
              tab === t.id
                ? 'text-indigo-400 border-b-2 border-indigo-500 bg-indigo-950/30'
                : 'text-gray-600 hover:text-gray-400 hover:bg-gray-900/30'
            }`}>
            {t.icon}<span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">

        {/* ── CHAT TAB ── */}
        {tab === 'chat' && (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-0">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 pb-8">
                  <div className="w-16 h-16 bg-gradient-to-br from-indigo-500/20 to-purple-600/20 rounded-2xl flex items-center justify-center mb-4 border border-indigo-500/20">
                    <Zap size={28} className="text-indigo-400"/>
                  </div>
                  <p className="text-lg font-semibold text-gray-300 mb-1">Autonomous AI Agent</p>
                  <p className="text-sm text-gray-500 mb-6 max-w-sm">
                    {settings.is_github_connected
                      ? `Connected as ${settings.github_username} · I can read, write, and push code to your repos`
                      : 'Connect GitHub in the Connect tab to give me access to your repos'
                    }
                  </p>
                  <div className="grid grid-cols-2 gap-2 w-full max-w-md">
                    {STARTERS.map(s => (
                      <button key={s.label} onClick={() => { setInput(s.text); setTimeout(() => inputRef.current?.focus(), 50); }}
                        className="flex items-center gap-2 text-left px-3 py-2.5 bg-gray-800/60 border border-gray-700/40 rounded-xl hover:border-indigo-600/40 hover:bg-gray-800 transition-all text-xs text-gray-400 hover:text-gray-200">
                        <span className="text-indigo-400 flex-shrink-0">{s.icon}</span>
                        <span>{s.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, idx) => (
                <MessageBubble
                  key={msg.id ?? idx}
                  msg={msg}
                  idx={idx}
                  onDelete={deleteMessage}
                  onCopy={copyText}
                  copied={copied}
                />
              ))}

              {isThinking && <ThinkingDots status={thinkingStatus}/>}
              <div ref={messagesEndRef}/>
            </div>

            {/* Input area */}
            <div className="p-4 border-t border-gray-800/60 bg-gray-950/95">
              {/* Context badges */}
              {(attachedRepo || settings.enable_web_search) && (
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  {attachedRepo && (
                    <div className="flex items-center gap-1.5 bg-indigo-900/30 border border-indigo-700/30 rounded-full px-2.5 py-1 text-[11px] text-indigo-300">
                      <FolderOpen size={11}/><span>{attachedRepo.full_name}</span>
                      <button onClick={() => setAttachedRepo(null)} className="hover:text-red-400 ml-0.5"><X size={10}/></button>
                    </div>
                  )}
                  {settings.enable_web_search && (
                    <div className="flex items-center gap-1.5 bg-green-900/20 border border-green-700/30 rounded-full px-2.5 py-1 text-[11px] text-green-400">
                      <Globe size={11}/><span>Web search</span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-end gap-2 bg-gray-800/60 border border-gray-700/40 rounded-2xl px-3 py-2 focus-within:border-indigo-600/50 transition-colors">
                <textarea
                  ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                  placeholder={settings.is_github_connected
                    ? `Ask me to read, fix, or build anything in your repos…`
                    : `Ask anything · Connect GitHub to unlock repo access…`
                  }
                  rows={1}
                  style={{ resize: 'none', maxHeight: '160px', height: 'auto', overflowY: input.split('\n').length > 4 ? 'auto' : 'hidden' }}
                  onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }}
                  className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none leading-relaxed py-1"
                />
                <button onClick={sendMessage} disabled={!input.trim() || isThinking}
                  className="w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all flex-shrink-0 shadow-lg shadow-indigo-600/30">
                  {isThinking ? <Loader2 size={15} className="animate-spin"/> : <Send size={15}/>}
                </button>
              </div>
              <p className="text-center text-[11px] text-gray-700 mt-2">
                Enter to send · Shift+Enter for new line · I use tools autonomously to complete tasks
              </p>
            </div>
          </>
        )}

        {/* ── CONNECTORS TAB ── */}
        {tab === 'connectors' && (
          <ConnectorsTab
            connectors={connectors} sessionId={sessionId}
            onRefresh={fetchConnectors} api={api}
            showAdd={showAddConnector} setShowAdd={setShowAddConnector}
          />
        )}

        {/* ── MODEL SETTINGS TAB ── */}
        {tab === 'model_settings' && (
          <ModelSettingsTab settings={settings} onSave={saveSettings}/>
        )}

        {/* ── INTEGRATIONS TAB ── */}
        {tab === 'integrations' && (
          <IntegrationsTab
            settings={settings} githubRepos={githubRepos} githubLoading={githubLoading}
            serviceConns={serviceConns} sessionId={sessionId}
            onSaveSettings={saveSettings} onRefreshConns={fetchServiceConns}
            onFetchRepos={fetchGithubRepos}
            api={api}
            showAdd={showAddService} setShowAdd={setShowAddService}
            connectError={connectError}
            signedInUser={signedInUser}
            onAttachRepo={(repo) => { setAttachedRepo(repo); setTab('chat'); }}
          />
        )}
      </div>
    </div>
  );
}

/* ─── Connectors Tab ─────────────────────────────────── */
function ConnectorsTab({ connectors, sessionId, onRefresh, api, showAdd, setShowAdd }: {
  connectors: ApiTemplate[]; sessionId: string;
  onRefresh: () => void;
  api: (path: string, opts?: RequestInit) => Promise<unknown>;
  showAdd: boolean; setShowAdd: (v: boolean) => void;
}) {
  const empty: ApiTemplate = { name: '', url: '', method: 'GET', headers_json: '{}', params_json: '{}', body_template: '', description: '' };
  const [form, setForm] = useState<ApiTemplate>(empty);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const save = async () => {
    if (!form.name || !form.url) return;
    await api('/api/db/connectors', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...form }) });
    setForm(empty); setShowAdd(false); onRefresh();
  };

  const del = async (id?: number) => {
    if (!id) return;
    await api(`/api/db/connectors?id=${id}`, { method: 'DELETE' });
    onRefresh();
  };

  const test = async (c: ApiTemplate, idx: number) => {
    setTesting(idx); setTestResult(null);
    try {
      const resp = await api('/api/execute-api', {
        method: 'POST', body: JSON.stringify({ url: c.url, method: c.method, headers: JSON.parse(c.headers_json || '{}'), params: JSON.parse(c.params_json || '{}'), body: c.body_template }),
      }) as { status_code: number; body: string };
      setTestResult(`✅ ${resp.status_code} — ${resp.body?.slice(0, 300)}`);
    } catch (e: unknown) { setTestResult(`❌ ${e instanceof Error ? e.message : 'Error'}`); }
    setTesting(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-semibold text-white">API Connectors</h2>
          <p className="text-xs text-gray-500 mt-0.5">Save API templates · call them from chat by name</p>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} className="flex items-center gap-1 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg px-3 py-1.5 text-white transition-colors">
          {showAdd ? <X size={12}/> : <Plus size={12}/>} {showAdd ? 'Cancel' : 'Add'}
        </button>
      </div>

      {showAdd && (
        <div className="bg-gray-800/60 border border-gray-700/40 rounded-xl p-4 mb-4 space-y-3">
          <h3 className="text-sm font-medium text-gray-200">New Connector</h3>
          {[['Name', 'name', 'Weather API'], ['URL', 'url', 'https://api.example.com/data'], ['Description', 'description', 'Optional description']].map(([label, key, ph]) => (
            <div key={key}>
              <label className="text-xs text-gray-400 mb-1 block">{label}</label>
              <input value={(form as unknown as Record<string, string>)[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                placeholder={ph} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
            </div>
          ))}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Method</label>
            <select value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
              className="bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 focus:ring-1 focus:ring-indigo-500">
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m}>{m}</option>)}
            </select>
          </div>
          {[['Headers (JSON)', 'headers_json', '{"Authorization": "Bearer token"}'], ['Params (JSON)', 'params_json', '{"limit": "10"}']].map(([label, key, ph]) => (
            <div key={key}>
              <label className="text-xs text-gray-400 mb-1 block">{label}</label>
              <textarea value={(form as unknown as Record<string, string>)[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                placeholder={ph} rows={2}
                className="w-full bg-gray-700 rounded-lg px-3 py-2 text-xs font-mono outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
            </div>
          ))}
          <button onClick={save} className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-lg py-2 text-sm font-medium transition-colors">Save Connector</button>
        </div>
      )}

      {connectors.length === 0 && !showAdd && (
        <div className="text-center py-16 text-gray-500">
          <Plug size={40} className="mx-auto mb-3 text-gray-700"/>
          <p className="text-sm">No connectors yet</p>
          <p className="text-xs mt-1 text-gray-600">Add API templates to call them quickly from chat</p>
        </div>
      )}

      {connectors.map((c, idx) => (
        <div key={c.id ?? idx} className="bg-gray-800/60 border border-gray-700/40 rounded-xl p-3 mb-3">
          <div className="flex items-start justify-between mb-1">
            <div>
              <p className="text-sm font-medium text-gray-200">{c.name}</p>
              {c.description && <p className="text-xs text-gray-500 mt-0.5">{c.description}</p>}
            </div>
            <div className="flex gap-1 ml-2">
              <button onClick={() => test(c, idx)} disabled={testing === idx}
                className="text-xs text-gray-400 hover:text-white px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors flex items-center gap-1">
                {testing === idx ? <Loader2 size={10} className="animate-spin"/> : <Eye size={10}/>} Test
              </button>
              <button onClick={() => del(c.id)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors">
                <Trash2 size={10}/>
              </button>
            </div>
          </div>
          <p className="text-xs text-indigo-400 font-mono">{c.method} {c.url.slice(0, 60)}{c.url.length > 60 ? '…' : ''}</p>
          {testResult !== null && testing === null && (
            <p className="text-xs text-gray-400 mt-2 font-mono bg-gray-900 p-2 rounded-lg whitespace-pre-wrap">{testResult}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── Model Settings Tab ─────────────────────────────── */
function ModelSettingsTab({ settings, onSave }: { settings: AppSettings; onSave: (s: AppSettings) => void }) {
  const [local, setLocal] = useState(settings);
  useEffect(() => { setLocal(settings); }, [settings]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5">
      <div>
        <h3 className="font-semibold text-white mb-3">Model</h3>
        <div className="bg-gray-800/60 border border-gray-700/40 rounded-xl p-4 space-y-4">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Active Model</label>
            <select value={local.active_model_name} onChange={e => setLocal(s => ({ ...s, active_model_name: e.target.value }))}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 focus:ring-1 focus:ring-indigo-500">
              <optgroup label="── GitHub Models (free · connect GitHub first)">
                <option value="gh:gpt-4.1">🔥 GPT-4.1 — Smartest (free)</option>
                <option value="gh:gpt-4.1-mini">GPT-4.1 Mini — Fast &amp; Smart (free)</option>
                <option value="gh:gpt-4.1-nano">GPT-4.1 Nano — Fastest (free)</option>
                <option value="gh:gpt-4o">GPT-4o (free)</option>
                <option value="gh:gpt-4o-mini">GPT-4o Mini (free)</option>
                <option value="gh:llama-3.3-70b">Llama 3.3 70B (Meta, free)</option>
                <option value="gh:llama-3.1-70b">Llama 3.1 70B (Meta, free)</option>
                <option value="gh:mistral-large">Mistral Large (free)</option>
                <option value="gh:phi-4">Phi-4 (Microsoft, free)</option>
                <option value="gh:deepseek-v3">DeepSeek V3 (free)</option>
              </optgroup>
              <optgroup label="── Gemini (add API key below or use server key)">
                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
              </optgroup>
              <optgroup label="── HuggingFace (add HF token below)">
                <option value="hf:Qwen/Qwen2.5-72B-Instruct">Qwen 2.5 72B</option>
                <option value="hf:meta-llama/Llama-3.1-70B-Instruct">Llama 3.1 70B</option>
                <option value="hf:mistralai/Mistral-7B-Instruct-v0.3">Mistral 7B</option>
                <option value="hf:google/gemma-2-27b-it">Gemma 2 27B</option>
                <option value="hf:DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking">Qwen3.6 40B Uncensored</option>
              </optgroup>
            </select>
            <p className="text-xs text-gray-600 mt-1">GitHub Models are free — just connect GitHub in the Connect tab first. Full tool loop on all models.</p>
          </div>

          {!local.is_custom_gemini_key_enabled && (
            <div className="flex items-center gap-2 bg-green-900/20 border border-green-700/30 rounded-lg px-3 py-2">
              <span className="text-green-400 text-sm">✓</span>
              <p className="text-xs text-green-300">Server Gemini key active — Gemini models ready to use</p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-200 flex items-center gap-1.5"><Globe size={13} className="text-green-400"/>Web search</p>
              <p className="text-xs text-gray-500">Let the agent browse for current info (Gemini only)</p>
            </div>
            <button onClick={() => setLocal(s => ({ ...s, enable_web_search: !s.enable_web_search }))}
              className={`w-10 h-6 rounded-full transition-colors ${local.enable_web_search ? 'bg-green-600' : 'bg-gray-600'}`}>
              <div className={`w-4 h-4 bg-white rounded-full mx-1 transition-transform ${local.enable_web_search ? 'translate-x-4' : ''}`}/>
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-200">Custom Gemini API key</p>
              <p className="text-xs text-gray-500">Override the server key</p>
            </div>
            <button onClick={() => setLocal(s => ({ ...s, is_custom_gemini_key_enabled: !s.is_custom_gemini_key_enabled }))}
              className={`w-10 h-6 rounded-full transition-colors ${local.is_custom_gemini_key_enabled ? 'bg-indigo-600' : 'bg-gray-600'}`}>
              <div className={`w-4 h-4 bg-white rounded-full mx-1 transition-transform ${local.is_custom_gemini_key_enabled ? 'translate-x-4' : ''}`}/>
            </button>
          </div>
          {local.is_custom_gemini_key_enabled && (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Gemini API Key</label>
              <input type="password" value={local.custom_gemini_api_key}
                onChange={e => setLocal(s => ({ ...s, custom_gemini_api_key: e.target.value }))}
                placeholder="AIza…" className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
            </div>
          )}

          <div>
            <label className="text-xs text-gray-400 mb-1 block">HuggingFace Token</label>
            <input type="password" value={local.hf_api_key || ''}
              onChange={e => setLocal(s => ({ ...s, hf_api_key: e.target.value }))}
              placeholder="hf_…" className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
            <p className="text-xs text-gray-600 mt-1">Required for gated HF models. Free at huggingface.co/settings/tokens</p>
          </div>
        </div>
      </div>

      <button onClick={() => onSave(local)} className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-xl py-3 text-sm font-medium transition-colors shadow-lg shadow-indigo-600/20">
        Save Settings
      </button>
    </div>
  );
}

/* ─── Integrations Tab ───────────────────────────────── */
function IntegrationsTab({ settings, githubRepos, githubLoading, serviceConns, sessionId, onSaveSettings, onRefreshConns, onFetchRepos, api, showAdd, setShowAdd, connectError, signedInUser, onAttachRepo }: {
  settings: AppSettings; githubRepos: GitHubRepo[]; githubLoading: boolean;
  serviceConns: ServiceConnection[]; sessionId: string;
  onSaveSettings: (s: AppSettings) => void; onRefreshConns: () => void; onFetchRepos: () => void;
  api: (path: string, opts?: RequestInit) => Promise<unknown>;
  showAdd: boolean; setShowAdd: (v: boolean) => void;
  connectError: string; signedInUser: { email: string; name: string; avatar: string } | null;
  onAttachRepo: (repo: { full_name: string; tree: string }) => void;
}) {
  const [newSvc, setNewSvc] = useState({ service_name: '', api_key: '' });
  const [loadingRepo, setLoadingRepo] = useState<string | null>(null);
  const [magicLinkEmail, setMagicLinkEmail] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [signInError, setSignInError] = useState('');

  const connectGitHub   = () => { window.location.href = '/api/github/auth'; };
  const connectSupabase = () => { window.location.href = '/api/supabase/auth'; };
  const connectVercel   = () => { window.location.href = '/api/vercel/auth'; };

  const disconnectGitHub = async () => {
    const updated = { ...settings, github_token: '', github_username: '', github_avatar_url: '', is_github_connected: false };
    await onSaveSettings(updated);
  };

  const connectGoogle = async () => {
    setSignInError('');
    const sbUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const sbAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!sbUrl || !sbAnon) { setSignInError('Supabase not configured on this deployment'); return; }
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(sbUrl, sbAnon);
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    if (error) setSignInError(error.message);
  };

  const sendMagicLink = async () => {
    setSignInError('');
    const sbUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const sbAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!sbUrl || !sbAnon) { setSignInError('Supabase not configured'); return; }
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(sbUrl, sbAnon);
    const { error } = await sb.auth.signInWithOtp({ email: magicLinkEmail, options: { emailRedirectTo: window.location.origin } });
    if (error) { setSignInError(error.message); return; }
    setMagicLinkSent(true);
  };

  const signOut = async () => {
    const sbUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const sbAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (sbUrl && sbAnon) {
      const { createClient } = await import('@supabase/supabase-js');
      await createClient(sbUrl, sbAnon).auth.signOut();
    }
    const updated = { ...settings, is_google_connected: false, google_user_email: '', google_user_name: '', google_avatar_url: '' };
    await onSaveSettings(updated);
  };

  const attachRepo = async (repo: GitHubRepo) => {
    setLoadingRepo(repo.full_name);
    try {
      const data = await api(`/api/github/files?repo=${encodeURIComponent(repo.full_name)}`) as { tree: string };
      onAttachRepo({ full_name: repo.full_name, tree: data.tree || '' });
    } catch { onAttachRepo({ full_name: repo.full_name, tree: '' }); }
    setLoadingRepo(null);
  };

  const saveNewSvc = async () => {
    if (!newSvc.service_name || !newSvc.api_key) return;
    await api('/api/db/service-connections', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...newSvc }) });
    setNewSvc({ service_name: '', api_key: '' }); setShowAdd(false); onRefreshConns();
  };

  const delSvc = async (id?: number) => {
    if (!id) return;
    await api(`/api/db/service-connections?id=${id}`, { method: 'DELETE' });
    onRefreshConns();
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5">
      {connectError && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-700/40 rounded-xl p-3 text-sm text-red-300">
          <AlertCircle size={16}/>{connectError}
        </div>
      )}

      {/* GitHub */}
      <div>
        <h3 className="font-semibold text-white mb-3 flex items-center gap-2"><Github size={16} className="text-gray-400"/>GitHub</h3>
        <div className="bg-gray-800/60 border border-gray-700/40 rounded-xl p-4">
          {settings.is_github_connected ? (
            <>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {settings.github_avatar_url && <img src={settings.github_avatar_url} className="w-8 h-8 rounded-full" alt=""/>}
                  <div>
                    <p className="text-sm font-medium text-white">{settings.github_username}</p>
                    <p className="text-xs text-green-400">✓ Connected · repos, files, commits, PRs, issues</p>
                  </div>
                </div>
                <button onClick={disconnectGitHub} className="text-xs text-gray-500 hover:text-red-400 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-gray-700 transition-colors">
                  <LogOut size={12}/>Disconnect
                </button>
              </div>
              <button onClick={onFetchRepos} disabled={githubLoading}
                className="w-full flex items-center justify-center gap-2 bg-gray-700 hover:bg-gray-600 rounded-lg py-2 text-sm transition-colors">
                {githubLoading ? <Loader2 size={14} className="animate-spin"/> : <Github size={14}/>}
                {githubLoading ? 'Loading repos…' : `Browse repos`}
              </button>
              {githubRepos.length > 0 && (
                <div className="mt-3 space-y-1.5 max-h-48 overflow-y-auto">
                  {githubRepos.slice(0, 20).map(r => (
                    <div key={r.id} className="flex items-center justify-between py-2 px-3 bg-gray-700/60 rounded-lg hover:bg-gray-700 transition-colors">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-200 truncate">{r.name}</p>
                        {r.description && <p className="text-[11px] text-gray-500 truncate">{r.description}</p>}
                      </div>
                      <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                        {r.language && <span className="text-[10px] text-gray-500">{r.language}</span>}
                        <button onClick={() => attachRepo(r)} disabled={loadingRepo === r.full_name}
                          className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 px-2 py-0.5 bg-indigo-900/30 rounded-lg transition-colors">
                          {loadingRepo === r.full_name ? <Loader2 size={10} className="animate-spin"/> : <FolderOpen size={10}/>}
                          Attach
                        </button>
                        <a href={r.html_url} target="_blank" rel="noopener" className="text-gray-600 hover:text-gray-400">
                          <ExternalLink size={11}/>
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-2">
              <p className="text-sm text-gray-400 mb-3">Connect GitHub to give the agent access to your repos — read, write, push, PR, issue creation. Free via OAuth.</p>
              <button onClick={connectGitHub}
                className="w-full flex items-center justify-center gap-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-xl py-3 text-sm font-medium transition-colors">
                <Github size={16}/>Connect GitHub
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Supabase */}
      <div>
        <h3 className="font-semibold text-white mb-3 flex items-center gap-2"><Database size={16} className="text-green-400"/>Supabase</h3>
        <div className="bg-gray-800/60 border border-gray-700/40 rounded-xl p-4">
          {settings.is_supabase_connected ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-green-300">✓ Connected as {settings.supabase_username}</p>
              <button onClick={() => onSaveSettings({ ...settings, supabase_access_token: '', supabase_username: '', is_supabase_connected: false })}
                className="text-xs text-gray-500 hover:text-red-400 flex items-center gap-1">
                <LogOut size={12}/>Disconnect
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-gray-400 mb-2">Connect to query tables, insert data, and manage your Supabase database from chat.</p>
              <button onClick={connectSupabase}
                className="w-full flex items-center justify-center gap-2 bg-green-900/30 hover:bg-green-900/50 border border-green-700/40 rounded-xl py-2.5 text-sm font-medium text-green-300 transition-colors">
                <Database size={14}/>Connect Supabase
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Vercel */}
      <div>
        <h3 className="font-semibold text-white mb-3 flex items-center gap-2"><Cloud size={16} className="text-blue-400"/>Vercel</h3>
        <div className="bg-gray-800/60 border border-gray-700/40 rounded-xl p-4">
          {settings.is_vercel_connected ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-blue-300">✓ Connected as {settings.vercel_username}</p>
              <button onClick={() => onSaveSettings({ ...settings, vercel_access_token: '', vercel_username: '', is_vercel_connected: false })}
                className="text-xs text-gray-500 hover:text-red-400 flex items-center gap-1">
                <LogOut size={12}/>Disconnect
              </button>
            </div>
          ) : (
            <div>
              <p className="text-xs text-gray-400 mb-2">Connect to list projects, manage env vars, and trigger deployments from chat.</p>
              <button onClick={connectVercel}
                className="w-full flex items-center justify-center gap-2 bg-blue-900/30 hover:bg-blue-900/50 border border-blue-700/40 rounded-xl py-2.5 text-sm font-medium text-blue-300 transition-colors">
                <Cloud size={14}/>Connect Vercel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Google / Supabase Auth */}
      <div>
        <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
          <span className="text-red-400 text-base">G</span>Google Account
        </h3>
        <div className="bg-gray-800/60 border border-gray-700/40 rounded-xl p-4 space-y-3">
          {signedInUser ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {signedInUser.avatar && <img src={signedInUser.avatar} className="w-7 h-7 rounded-full" alt=""/>}
                <div>
                  <p className="text-sm text-white">{signedInUser.name}</p>
                  <p className="text-xs text-gray-400">{signedInUser.email}</p>
                </div>
              </div>
              <button onClick={signOut} className="text-xs text-gray-500 hover:text-red-400 flex items-center gap-1">
                <LogOut size={12}/>Sign out
              </button>
            </div>
          ) : (
            <>
              <button onClick={connectGoogle}
                className="w-full flex items-center justify-center gap-2 bg-red-900/20 hover:bg-red-900/30 border border-red-700/30 rounded-xl py-2.5 text-sm font-medium text-red-300 transition-colors">
                Sign in with Google
              </button>
              <div className="flex items-center gap-2">
                <div className="flex-1 border-t border-gray-700"/>
                <span className="text-xs text-gray-600">or</span>
                <div className="flex-1 border-t border-gray-700"/>
              </div>
              <div className="flex gap-2">
                <input type="email" value={magicLinkEmail} onChange={e => setMagicLinkEmail(e.target.value)}
                  placeholder="your@email.com" className="flex-1 bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
                <button onClick={sendMagicLink} disabled={!magicLinkEmail || magicLinkSent}
                  className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">
                  {magicLinkSent ? '✓ Sent' : 'Magic link'}
                </button>
              </div>
              {magicLinkSent && <p className="text-xs text-green-400">Check your email for the sign-in link!</p>}
              {signInError && <p className="text-xs text-red-400">{signInError}</p>}
            </>
          )}
        </div>
      </div>

      {/* API Keys vault */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-white">API Key Vault</h3>
          <button onClick={() => setShowAdd(!showAdd)} className="flex items-center gap-1 text-xs bg-gray-700 hover:bg-gray-600 rounded-lg px-2.5 py-1.5 text-gray-300 transition-colors">
            {showAdd ? <X size={11}/> : <Plus size={11}/>} {showAdd ? 'Cancel' : 'Add key'}
          </button>
        </div>
        <div className="bg-gray-800/60 border border-gray-700/40 rounded-xl p-4 space-y-3">
          {showAdd && (
            <div className="space-y-2 pb-3 border-b border-gray-700">
              <input value={newSvc.service_name} onChange={e => setNewSvc(s => ({ ...s, service_name: e.target.value }))}
                placeholder="Service name (e.g. OpenAI, Stripe, Railway)"
                className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
              <input type="password" value={newSvc.api_key} onChange={e => setNewSvc(s => ({ ...s, api_key: e.target.value }))}
                placeholder="API key or token"
                className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
              <button onClick={saveNewSvc} className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-lg py-2 text-sm font-medium transition-colors">Save</button>
            </div>
          )}
          {serviceConns.length === 0 && !showAdd && (
            <p className="text-xs text-gray-500 text-center py-2">No API keys stored yet · Reference them in chat by service name</p>
          )}
          {serviceConns.map(s => (
            <div key={s.id} className="flex items-center justify-between py-2 border-b border-gray-700/40 last:border-0">
              <div>
                <p className="text-sm text-gray-200">{s.service_name}</p>
                <p className="text-xs text-gray-500 font-mono">{s.api_key.slice(0, 8)}{'•'.repeat(Math.min(16, s.api_key.length - 8))}</p>
              </div>
              <button onClick={() => delSvc(s.id)} className="text-gray-600 hover:text-red-400 p-1 rounded transition-colors">
                <Trash2 size={13}/>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
