'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send, Bot, Plug, Settings, Github, Trash2, Plus, Copy, Check,
  ChevronDown, ChevronUp, Loader2, X, AlertCircle, LogOut,
  Globe, FolderOpen, ExternalLink
} from 'lucide-react';

/* ─── Types ─────────────────────────────────────────── */
interface Message {
  id?: number;
  text: string;
  is_user: boolean;
  status?: string;
  api_call_url?: string;
  api_call_response?: string;
  api_call_status?: number;
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
  github_token: string;
  github_username: string;
  github_avatar_url: string;
  is_github_connected: boolean;
  enable_web_search: boolean;
}
interface GitHubRepo { id: number; name: string; full_name: string; description: string; html_url: string; language: string; stargazers_count: number; }

const DEFAULT_SETTINGS: AppSettings = {
  is_custom_gemini_key_enabled: false, custom_gemini_api_key: '',
  active_model_name: 'gemini-2.5-flash', is_custom_model_enabled: false,
  custom_model_endpoint: '', custom_model_api_key: '', custom_model_name: '',
  github_token: '', github_username: '', github_avatar_url: '', is_github_connected: false,
  enable_web_search: false,
};

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

type Tab = 'chat' | 'connectors' | 'model_settings' | 'integrations';

/* ─── Main Component ─────────────────────────────────── */
export default function Home() {
  const [tab, setTab] = useState<Tab>('chat');
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [connectors, setConnectors] = useState<ApiTemplate[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [serviceConns, setServiceConns] = useState<ServiceConnection[]>([]);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showAddConnector, setShowAddConnector] = useState(false);
  const [showAddService, setShowAddService] = useState(false);
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null);
  const [attachedRepo, setAttachedRepo] = useState<{ full_name: string; tree: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* Init session */
  useEffect(() => {
    let sid = localStorage.getItem('agent_session_id');
    if (!sid) { sid = crypto.randomUUID(); localStorage.setItem('agent_session_id', sid); }
    setSessionId(sid);
  }, []);

  /* Load data when session ready */
  useEffect(() => {
    if (!sessionId) return;
    fetchMessages();
    fetchConnectors();
    fetchSettings();
    fetchServiceConns();
    // Handle GitHub OAuth callback
    const params = new URLSearchParams(window.location.search);
    const ghToken = params.get('gh_token');
    const ghUser = params.get('gh_user');
    const ghAvatar = params.get('gh_avatar');
    if (ghToken && ghUser) {
      const updated = { ...DEFAULT_SETTINGS, github_token: ghToken, github_username: ghUser, github_avatar_url: ghAvatar || '', is_github_connected: true };
      saveSettings(updated);
      window.history.replaceState({}, '', '/');
      setTab('integrations');
    }
  }, [sessionId]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  /* ── API helpers ── */
  const api = useCallback(async (path: string, opts?: RequestInit) => {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...opts?.headers } });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  const fetchMessages = useCallback(async () => {
    if (!sessionId) return;
    try { const data = await api(`/api/db/messages?session_id=${sessionId}`); setMessages(data || []); } catch {}
  }, [sessionId, api]);

  const fetchConnectors = useCallback(async () => {
    if (!sessionId) return;
    try { const data = await api(`/api/db/connectors?session_id=${sessionId}`); setConnectors(data || []); } catch {}
  }, [sessionId, api]);

  const fetchSettings = useCallback(async () => {
    if (!sessionId) return;
    try { const data = await api(`/api/db/settings?session_id=${sessionId}`); if (data) setSettings(data); } catch {}
  }, [sessionId, api]);

  const fetchServiceConns = useCallback(async () => {
    if (!sessionId) return;
    try { const data = await api(`/api/db/service-connections?session_id=${sessionId}`); setServiceConns(data || []); } catch {}
  }, [sessionId, api]);

  const saveSettings = useCallback(async (s: AppSettings) => {
    if (!sessionId) return;
    try {
      await api('/api/db/settings', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...s }) });
      setSettings(s);
    } catch {}
  }, [sessionId, api]);

  const loadGithubRepos = useCallback(async (token: string) => {
    setGithubLoading(true);
    try { const data = await api(`/api/github/repos?token=${encodeURIComponent(token)}`); setGithubRepos(data || []); } catch {}
    finally { setGithubLoading(false); }
  }, [api]);

  useEffect(() => {
    if (settings.is_github_connected && settings.github_token && tab === 'integrations') {
      loadGithubRepos(settings.github_token);
    }
  }, [settings.is_github_connected, settings.github_token, tab]);

  /* ── Send message ── */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isThinking || !sessionId) return;
    setInput('');
    setIsThinking(true);

    const userMsg: Message = { text, is_user: true, status: 'SUCCESS' };
    setMessages(prev => [...prev, userMsg]);

    try {
      // Save user message
      await api('/api/db/messages', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...userMsg }) });

      // Check if it looks like an API call URL
      const urlMatch = text.match(/https?:\/\/[^\s]+/);
      let aiText = '';

      if (urlMatch) {
        const apiResp = await api('/api/execute-api', {
          method: 'POST',
          body: JSON.stringify({ url: urlMatch[0], method: 'GET', headers: {}, params: {}, body: null }),
        });
        aiText = `API Response (${apiResp.status_code}):\n\`\`\`json\n${JSON.stringify(JSON.parse(apiResp.body || '{}'), null, 2)}\n\`\`\``;
        const aiMsg: Message = { text: aiText, is_user: false, status: 'SUCCESS', api_call_url: urlMatch[0], api_call_response: apiResp.body, api_call_status: apiResp.status_code };
        setMessages(prev => [...prev, aiMsg]);
        await api('/api/db/messages', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...aiMsg }) });
      } else {
        const history = messages.slice(-20).map(m => ({ role: m.is_user ? 'user' : 'model', text: m.text }));
        const messageWithContext = attachedRepo
          ? `[Repo context: ${attachedRepo.full_name}]\n${attachedRepo.tree}\n\n---\n${text}`
          : text;
        const resp = await api('/api/chat', {
          method: 'POST',
          body: JSON.stringify({ message: messageWithContext, history, session_id: sessionId, settings }),
        });
        aiText = resp.text || 'No response.';
        const aiMsg: Message = { text: aiText, is_user: false, status: 'SUCCESS' };
        setMessages(prev => [...prev, aiMsg]);
        await api('/api/db/messages', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...aiMsg }) });
      }
    } catch (e: unknown) {
      const errText = e instanceof Error ? e.message : 'Error sending message.';
      const errMsg: Message = { text: `Error: ${errText}`, is_user: false, status: 'ERROR' };
      setMessages(prev => [...prev, errMsg]);
      await api('/api/db/messages', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...errMsg }) }).catch(() => {});
    } finally {
      setIsThinking(false);
    }
  }, [input, isThinking, sessionId, messages, settings, api]);

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

  /* ── Render helpers ── */
  const renderMessage = (msg: Message, idx: number) => {
    const key = msg.id ?? idx;
    const isExpanded = expandedMsg === idx;
    const hasApi = !!msg.api_call_url;
    return (
      <div key={key} className={`flex ${msg.is_user ? 'justify-end' : 'justify-start'} mb-3 group`}>
        {!msg.is_user && (
          <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center mr-2 flex-shrink-0 mt-1">
            <Bot size={16} />
          </div>
        )}
        <div className={`max-w-[80%] ${msg.is_user ? 'items-end' : 'items-start'} flex flex-col`}>
          <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
            msg.is_user ? 'message-bubble-user rounded-tr-sm' : 'message-bubble-ai rounded-tl-sm'
          } ${msg.status === 'ERROR' ? 'border border-red-500/50 bg-red-900/20' : ''}`}>
            {msg.status === 'ERROR' && <AlertCircle size={14} className="inline mr-1 text-red-400" />}
            {msg.text}
          </div>
          {hasApi && (
            <button onClick={() => setExpandedMsg(isExpanded ? null : idx)} className="text-xs text-gray-500 mt-1 flex items-center gap-1 hover:text-gray-300">
              API: {msg.api_call_url?.slice(0, 40)}... {isExpanded ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
            </button>
          )}
          {hasApi && isExpanded && (
            <div className="mt-1 p-2 bg-gray-800 rounded-lg text-xs text-gray-300 max-w-full overflow-auto">
              <div className="text-gray-500 mb-1">Status: {msg.api_call_status}</div>
              <pre className="whitespace-pre-wrap break-all">{msg.api_call_response?.slice(0, 500)}</pre>
            </div>
          )}
          <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => copyText(msg.text, `msg-${key}`)} className="text-gray-500 hover:text-gray-300 p-0.5">
              {copied === `msg-${key}` ? <Check size={12}/> : <Copy size={12}/>}
            </button>
            {!msg.is_user && (
              <button onClick={() => deleteMessage(msg.id)} className="text-gray-500 hover:text-red-400 p-0.5">
                <Trash2 size={12}/>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  /* ── Tabs ── */
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'chat', label: 'Chat', icon: <Bot size={18}/> },
    { id: 'connectors', label: 'Connectors', icon: <Plug size={18}/> },
    { id: 'model_settings', label: 'Model', icon: <Settings size={18}/> },
    { id: 'integrations', label: 'GitHub', icon: <Github size={18}/> },
  ];

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-950">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
            <Bot size={18}/>
          </div>
          <span className="font-semibold text-white">API AI Agent</span>
        </div>
        {tab === 'chat' && messages.length > 0 && (
          <button onClick={clearChat} className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1">
            <Trash2 size={12}/> Clear
          </button>
        )}
      </div>

      {/* Tab nav */}
      <div className="flex border-b border-gray-800 bg-gray-950">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs transition-colors ${
              tab === t.id ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500 hover:text-gray-300'
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
            <div className="flex-1 overflow-y-auto px-4 py-4">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center text-gray-500">
                  <Bot size={48} className="mb-4 text-indigo-600/40"/>
                  <p className="text-lg font-medium text-gray-400">API AI Agent</p>
                  <p className="text-sm mt-1">Ask anything or paste an API URL to call it</p>
                  <div className="mt-4 grid grid-cols-1 gap-2 text-xs">
                    {['Explain this JSON response: {"status": "ok"}', 'POST https://httpbin.org/post', 'What is REST API?'].map(s => (
                      <button key={s} onClick={() => setInput(s)} className="text-left px-3 py-2 bg-gray-800/60 rounded-lg hover:bg-gray-700/60 text-gray-400 hover:text-gray-200 transition-colors">
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, idx) => renderMessage(msg, idx))}
              {isThinking && (
                <div className="flex justify-start mb-3">
                  <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center mr-2 flex-shrink-0">
                    <Bot size={16}/>
                  </div>
                  <div className="message-bubble-ai rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin text-indigo-400"/>
                    <span className="text-sm text-gray-400">Thinking…</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef}/>
            </div>
            <div className="p-4 border-t border-gray-800 bg-gray-950">
              {/* Attached context badges */}
              {(attachedRepo || settings.enable_web_search) && (
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  {attachedRepo && (
                    <div className="flex items-center gap-1.5 bg-indigo-900/40 border border-indigo-700/40 rounded-full px-2.5 py-1 text-xs text-indigo-300">
                      <FolderOpen size={11}/>
                      <span>{attachedRepo.full_name}</span>
                      <button onClick={() => setAttachedRepo(null)} className="hover:text-red-400 ml-0.5"><X size={10}/></button>
                    </div>
                  )}
                  {settings.enable_web_search && (
                    <div className="flex items-center gap-1.5 bg-green-900/30 border border-green-700/30 rounded-full px-2.5 py-1 text-xs text-green-400">
                      <Globe size={11}/>
                      <span>Web search on</span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-end gap-2 bg-gray-800 rounded-2xl px-3 py-2">
                <textarea
                  ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                  placeholder="Message or paste an API URL…"
                  rows={1} style={{ resize: 'none', maxHeight: '120px' }}
                  className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none leading-relaxed py-1"
                />
                <button onClick={sendMessage} disabled={!input.trim() || isThinking}
                  className="w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors flex-shrink-0">
                  <Send size={15}/>
                </button>
              </div>
              <p className="text-center text-xs text-gray-600 mt-2">Enter to send · Shift+Enter for new line</p>
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
          <ModelSettingsTab settings={settings} onSave={saveSettings} models={GEMINI_MODELS}/>
        )}

        {/* ── INTEGRATIONS TAB ── */}
        {tab === 'integrations' && (
          <IntegrationsTab
            settings={settings} githubRepos={githubRepos} githubLoading={githubLoading}
            serviceConns={serviceConns} sessionId={sessionId}
            onSaveSettings={saveSettings} onRefreshConns={fetchServiceConns} api={api}
            showAdd={showAddService} setShowAdd={setShowAddService}
            onAttachRepo={(repo) => { setAttachedRepo(repo); setTab('chat'); }}
          />
        )}
      </div>
    </div>
  );
}

/* ─── Connectors Tab ───────────────────────────────── */
function ConnectorsTab({ connectors, sessionId, onRefresh, api, showAdd, setShowAdd }: {
  connectors: ApiTemplate[]; sessionId: string;
  onRefresh: () => void; api: (path: string, opts?: RequestInit) => Promise<unknown>;
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
      setTestResult(`✅ ${resp.status_code} — ${resp.body?.slice(0, 200)}`);
    } catch (e: unknown) {
      setTestResult(`❌ ${e instanceof Error ? e.message : 'Error'}`);
    }
    setTesting(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-white">API Connectors</h2>
        <button onClick={() => setShowAdd(!showAdd)} className="flex items-center gap-1 text-xs bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 rounded-lg transition-colors">
          {showAdd ? <X size={12}/> : <Plus size={12}/>} {showAdd ? 'Cancel' : 'Add'}
        </button>
      </div>

      {showAdd && (
        <div className="bg-gray-800 rounded-xl p-4 mb-4 space-y-3">
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
                className="w-full bg-gray-700 rounded-lg px-3 py-2 text-xs font-mono outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500 resize-none"/>
            </div>
          ))}
          <button onClick={save} className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-lg py-2 text-sm font-medium transition-colors">Save Connector</button>
        </div>
      )}

      {connectors.length === 0 && !showAdd && (
        <div className="text-center py-12 text-gray-500">
          <Plug size={40} className="mx-auto mb-3 text-gray-700"/>
          <p className="text-sm">No connectors yet</p>
          <p className="text-xs mt-1">Add API templates to quickly call them from chat</p>
        </div>
      )}

      {connectors.map((c, idx) => (
        <div key={c.id ?? idx} className="bg-gray-800 rounded-xl p-4 mb-3">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-xs px-1.5 py-0.5 rounded font-mono font-bold ${
                  c.method === 'GET' ? 'bg-green-900/50 text-green-400' :
                  c.method === 'POST' ? 'bg-blue-900/50 text-blue-400' :
                  c.method === 'DELETE' ? 'bg-red-900/50 text-red-400' : 'bg-yellow-900/50 text-yellow-400'
                }`}>{c.method}</span>
                <span className="font-medium text-sm text-white">{c.name}</span>
              </div>
              <p className="text-xs text-gray-500 mt-1 truncate">{c.url}</p>
              {c.description && <p className="text-xs text-gray-400 mt-0.5">{c.description}</p>}
            </div>
            <div className="flex items-center gap-1 ml-2">
              <button onClick={() => test(c, idx)} disabled={testing === idx}
                className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
                {testing === idx ? <Loader2 size={10} className="animate-spin"/> : null} Test
              </button>
              <button onClick={() => del(c.id)} className="text-gray-500 hover:text-red-400 p-1 transition-colors"><Trash2 size={14}/></button>
            </div>
          </div>
          {testResult && testing !== idx && (
            <div className="mt-2 p-2 bg-gray-900 rounded-lg text-xs text-gray-300 font-mono whitespace-pre-wrap break-all">{testResult}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── Model Settings Tab ───────────────────────────── */
function ModelSettingsTab({ settings, onSave, models }: { settings: AppSettings; onSave: (s: AppSettings) => void; models: string[] }) {
  const [local, setLocal] = useState(settings);
  useEffect(() => setLocal(settings), [settings]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      <div>
        <h2 className="font-semibold text-white mb-4">Model Settings</h2>
        <div className="bg-gray-800 rounded-xl p-4 space-y-4">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Active Model</label>
            <select value={local.active_model_name} onChange={e => setLocal(s => ({ ...s, active_model_name: e.target.value }))}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 focus:ring-1 focus:ring-indigo-500">
              {models.map(m => <option key={m}>{m}</option>)}
            </select>
            <p className="text-xs text-gray-500 mt-1">gemini-2.5-flash — fastest · gemini-2.5-flash-lite — most efficient</p>
          </div>
          {!local.is_custom_gemini_key_enabled && (
            <div className="flex items-center gap-2 bg-green-900/30 border border-green-700/40 rounded-lg px-3 py-2">
              <span className="text-green-400 text-xs">✓</span>
              <p className="text-xs text-green-300">Server Gemini API key active — chat is ready to use</p>
            </div>
          )}
          {/* Web Search */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-200 flex items-center gap-1.5"><Globe size={14} className="text-green-400"/>Web search</p>
              <p className="text-xs text-gray-500">Let the AI browse the internet for current info</p>
            </div>
            <button onClick={() => setLocal(s => ({ ...s, enable_web_search: !s.enable_web_search }))}
              className={`w-10 h-6 rounded-full transition-colors ${local.enable_web_search ? 'bg-green-600' : 'bg-gray-600'}`}>
              <div className={`w-4 h-4 bg-white rounded-full mx-1 transition-transform ${local.enable_web_search ? 'translate-x-4' : ''}`}/>
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-200">Use a different Gemini API key</p>
              <p className="text-xs text-gray-500">Only needed if you want to override the active server key</p>
            </div>
            <button onClick={() => setLocal(s => ({ ...s, is_custom_gemini_key_enabled: !s.is_custom_gemini_key_enabled }))}
              className={`w-10 h-6 rounded-full transition-colors ${local.is_custom_gemini_key_enabled ? 'bg-indigo-600' : 'bg-gray-600'}`}>
              <div className={`w-4 h-4 bg-white rounded-full mx-1 transition-transform ${local.is_custom_gemini_key_enabled ? 'translate-x-4' : ''}`}/>
            </button>
          </div>
          {local.is_custom_gemini_key_enabled && (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Gemini API Key</label>
              <input type="password" value={local.custom_gemini_api_key} onChange={e => setLocal(s => ({ ...s, custom_gemini_api_key: e.target.value }))}
                placeholder="AIza…" className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
            </div>
          )}
        </div>
      </div>

      <div>
        <h3 className="font-medium text-gray-300 mb-3">Custom Model Endpoint</h3>
        <div className="bg-gray-800 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-200">Enable custom model</p>
              <p className="text-xs text-gray-500">Use any OpenAI-compatible endpoint</p>
            </div>
            <button onClick={() => setLocal(s => ({ ...s, is_custom_model_enabled: !s.is_custom_model_enabled }))}
              className={`w-10 h-6 rounded-full transition-colors ${local.is_custom_model_enabled ? 'bg-indigo-600' : 'bg-gray-600'}`}>
              <div className={`w-4 h-4 bg-white rounded-full mx-1 transition-transform ${local.is_custom_model_enabled ? 'translate-x-4' : ''}`}/>
            </button>
          </div>
          {local.is_custom_model_enabled && (
            <>
              {[['Endpoint URL', 'custom_model_endpoint', 'https://api.openai.com/v1/chat/completions', 'text'],
                ['Model Name', 'custom_model_name', 'gpt-4o-mini', 'text'],
                ['API Key', 'custom_model_api_key', 'sk-…', 'password']
              ].map(([label, key, ph, type]) => (
                <div key={key}>
                  <label className="text-xs text-gray-400 mb-1 block">{label}</label>
                  <input type={type} value={(local as unknown as Record<string, string>)[key]} onChange={e => setLocal(s => ({ ...s, [key]: e.target.value }))}
                    placeholder={ph} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <button onClick={() => onSave(local)} className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-xl py-3 text-sm font-medium transition-colors">
        Save Settings
      </button>
    </div>
  );
}

/* ─── Integrations Tab ─────────────────────────────── */
function IntegrationsTab({ settings, githubRepos, githubLoading, serviceConns, sessionId, onSaveSettings, onRefreshConns, api, showAdd, setShowAdd, onAttachRepo }: {
  settings: AppSettings; githubRepos: GitHubRepo[]; githubLoading: boolean;
  serviceConns: ServiceConnection[]; sessionId: string;
  onSaveSettings: (s: AppSettings) => void;
  onRefreshConns: () => void;
  api: (path: string, opts?: RequestInit) => Promise<unknown>;
  showAdd: boolean; setShowAdd: (v: boolean) => void;
  onAttachRepo: (repo: { full_name: string; tree: string }) => void;
}) {
  const [newSvc, setNewSvc] = useState({ service_name: '', api_key: '' });
  const [loadingRepo, setLoadingRepo] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');

  const PRESET_SERVICES = [
    { name: 'Railway', placeholder: 'API token (from railway.app/account/tokens)' },
    { name: 'OpenAI', placeholder: 'sk-...' },
    { name: 'Anthropic', placeholder: 'sk-ant-...' },
    { name: 'Stripe', placeholder: 'sk_live_... or sk_test_...' },
    { name: 'Supabase', placeholder: 'Service role key' },
    { name: 'Resend', placeholder: 're_...' },
    { name: 'Upstash Redis', placeholder: 'Redis REST token' },
    { name: 'PlanetScale', placeholder: 'Database URL / token' },
  ];

  const connectGitHub = async () => {
    setConnectError('');
    try {
      const data = await api('/api/github/connect') as { username?: string; avatar_url?: string; error?: string } | null;
      if (data?.error) {
        setConnectError(data.error);
        return;
      }
      if (data?.username) {
        onSaveSettings({ ...settings, github_username: data.username, github_avatar_url: data.avatar_url || '', is_github_connected: true });
      } else {
        setConnectError('No username returned — check GITHUB_TOKEN on the server.');
      }
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Network error — try again');
    }
  };
  const disconnectGitHub = () => {
    setConnectError('');
    onSaveSettings({ ...settings, github_token: '', github_username: '', github_avatar_url: '', is_github_connected: false });
  };
  const addService = async () => {
    if (!newSvc.service_name || !newSvc.api_key) return;
    await api('/api/db/service-connections', { method: 'POST', body: JSON.stringify({ session_id: sessionId, ...newSvc }) });
    setNewSvc({ service_name: '', api_key: '' }); setShowAdd(false); onRefreshConns();
  };
  const delService = async (id?: number) => {
    if (!id) return;
    await api(`/api/db/service-connections?id=${id}`, { method: 'DELETE' }); onRefreshConns();
  };

  const loadRepoToChat = async (repo: GitHubRepo) => {
    setLoadingRepo(repo.full_name);
    try {
      // Use server-side token — no need to pass token in URL
      const data = await api(`/api/github/files?repo=${encodeURIComponent(repo.full_name)}`) as { items?: { name: string; path: string; type: string }[]; error?: string };
      if (data?.error) { setLoadingRepo(null); return; }
      const tree = (data?.items || [])
        .map((f: { name: string; type: string }) => `${f.type === 'dir' ? '📁' : '📄'} ${f.name}`)
        .join('\n');
      onAttachRepo({ full_name: repo.full_name, tree: `Root of ${repo.full_name}:\n${tree}` });
    } catch { /* ignore */ } finally {
      setLoadingRepo(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {/* GitHub */}
      <div>
        <h2 className="font-semibold text-white mb-4">GitHub Integration</h2>
        <div className="bg-gray-800 rounded-xl p-4">
          {settings.is_github_connected ? (
            <>
              <div className="flex items-center gap-3 mb-4">
                {settings.github_avatar_url && (
                  <img src={settings.github_avatar_url} alt="" className="w-10 h-10 rounded-full"/>
                )}
                <div>
                  <p className="font-medium text-white">{settings.github_username}</p>
                  <p className="text-xs text-green-400">● Connected</p>
                </div>
                <button onClick={disconnectGitHub} className="ml-auto text-gray-500 hover:text-red-400 p-1 transition-colors"><LogOut size={16}/></button>
              </div>
              {githubLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={14} className="animate-spin"/> Loading repos…</div>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {githubRepos.map(r => (
                    <div key={r.id} className="bg-gray-700/50 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <a href={r.html_url} target="_blank" rel="noopener noreferrer"
                          className="text-sm font-medium text-white hover:text-indigo-300 flex items-center gap-1">
                          {r.name} <ExternalLink size={11} className="text-gray-500"/>
                        </a>
                        <div className="flex items-center gap-1.5">
                          {r.language && <span className="text-xs text-gray-400">{r.language}</span>}
                          <button onClick={() => loadRepoToChat(r)} disabled={loadingRepo === r.full_name}
                            className="text-xs bg-indigo-700 hover:bg-indigo-600 px-2 py-0.5 rounded-md flex items-center gap-1 transition-colors disabled:opacity-60">
                            {loadingRepo === r.full_name ? <Loader2 size={10} className="animate-spin"/> : <FolderOpen size={10}/>}
                            Load to chat
                          </button>
                        </div>
                      </div>
                      {r.description && <p className="text-xs text-gray-500 truncate">{r.description}</p>}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-4">
              <Github size={32} className="mx-auto mb-3 text-gray-600"/>
              <p className="text-sm text-gray-400 mb-3">Connect your GitHub account to view and work on repos</p>
              {connectError && (
                <div className="mb-3 bg-red-900/40 border border-red-700/50 rounded-lg px-3 py-2 text-xs text-red-300 text-left">
                  <AlertCircle size={12} className="inline mr-1"/>{connectError}
                </div>
              )}
              <button onClick={connectGitHub} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 mx-auto">
                <Github size={16}/> Connect GitHub
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Service connections */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-gray-300">3rd Party Services</h3>
          <button onClick={() => setShowAdd(!showAdd)} className="flex items-center gap-1 text-xs bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 rounded-lg transition-colors">
            {showAdd ? <X size={12}/> : <Plus size={12}/>} {showAdd ? 'Cancel' : 'Add'}
          </button>
        </div>
        {showAdd && (
          <div className="bg-gray-800 rounded-xl p-4 mb-3 space-y-3">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Service</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {PRESET_SERVICES.map(p => (
                  <button key={p.name} onClick={() => setNewSvc(s => ({ ...s, service_name: p.name }))}
                    className={`text-xs px-2 py-1 rounded-md transition-colors ${newSvc.service_name === p.name ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}>
                    {p.name}
                  </button>
                ))}
              </div>
              <input value={newSvc.service_name} onChange={e => setNewSvc(s => ({ ...s, service_name: e.target.value }))}
                placeholder="Or type a custom service name"
                className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">API Key / Token</label>
              <input value={newSvc.api_key} onChange={e => setNewSvc(s => ({ ...s, api_key: e.target.value }))}
                placeholder={PRESET_SERVICES.find(p => p.name === newSvc.service_name)?.placeholder || 'Your API key'}
                type="password"
                className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none text-gray-100 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500"/>
            </div>
            <button onClick={addService} className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-lg py-2 text-sm font-medium transition-colors">Save</button>
          </div>
        )}
        {serviceConns.map(s => (
          <div key={s.id} className="bg-gray-800 rounded-xl p-3 mb-2 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white">{s.service_name}</p>
              <p className="text-xs text-gray-500">{'•'.repeat(12)}</p>
            </div>
            <button onClick={() => delService(s.id)} className="text-gray-500 hover:text-red-400 p-1"><Trash2 size={14}/></button>
          </div>
        ))}
        {serviceConns.length === 0 && !showAdd && (
          <p className="text-sm text-gray-500 text-center py-4">No services added yet</p>
        )}
      </div>
    </div>
  );
}
