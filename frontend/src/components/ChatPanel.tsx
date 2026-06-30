import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { sendChat, approveCall, setChatAutoMode, getChat } from '../api';

const ROLE_STYLE: Record<string, string> = {
  user: 'bg-accent/15 text-text self-end',
  assistant: 'bg-surface border border-border text-text/90',
  tool: 'text-[10px] font-mono text-muted/70 italic',
  error: 'bg-danger/15 text-danger',
};

export default function ChatPanel({ sessionId }: { sessionId: string }) {
  const {
    chatOpen, setChatOpen, chatMessages, appendChatMessage, setChatMessages,
    chatBusy, setChatBusy, chatPending, setChatPending,
    chatAutoMode, setChatAutoModeState,
  } = useAppStore();

  const [input, setInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [editParams, setEditParams] = useState('');
  const [denyReason, setDenyReason] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load the persisted transcript + auto-mode when the session changes.
  useEffect(() => {
    getChat(sessionId)
      .then((c) => {
        setChatMessages(c.transcript.map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text })));
        setChatAutoModeState(c.auto_mode);
      })
      .catch(() => {});
  }, [sessionId, setChatMessages, setChatAutoModeState]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chatMessages, chatPending]);

  async function send() {
    const msg = input.trim();
    if (!msg || chatBusy) return;
    appendChatMessage({ role: 'user', text: msg });
    setInput('');
    setChatBusy(true);
    try {
      await sendChat(sessionId, msg);
    } catch (err) {
      appendChatMessage({ role: 'error', text: err instanceof Error ? err.message : String(err) });
      setChatBusy(false);
    }
  }

  async function toggleAuto() {
    const next = !chatAutoMode;
    setChatAutoModeState(next);
    try { await setChatAutoMode(sessionId, next); } catch { /* surfaced elsewhere */ }
  }

  async function resolve(action: 'approve' | 'edit' | 'deny') {
    if (!chatPending) return;
    const body: { call_id: string; action: typeof action; params?: unknown; reason?: string } = {
      call_id: chatPending.call_id, action,
    };
    if (action === 'edit') {
      try { body.params = JSON.parse(editParams); }
      catch { appendChatMessage({ role: 'error', text: 'Edited params are not valid JSON' }); return; }
    }
    if (action === 'deny') body.reason = denyReason || undefined;
    setChatPending(null);
    setEditing(false);
    setDenyReason('');
    try { await approveCall(sessionId, body); } catch (err) {
      appendChatMessage({ role: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!chatOpen) {
    return (
      <button
        onClick={() => setChatOpen(true)}
        className="absolute top-2 right-2 z-20 px-2 py-1 text-xs bg-accent/20 hover:bg-accent/30 text-accent rounded transition-colors"
      >
        AI chat
      </button>
    );
  }

  return (
    <aside className="w-80 shrink-0 bg-surface border-l border-border flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-sm font-semibold text-text">AI assistant</span>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleAuto}
            title="When on, the agent runs functions without asking for approval"
            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${chatAutoMode ? 'bg-warn/25 text-warn' : 'bg-bg border border-border text-muted'}`}
          >
            Auto {chatAutoMode ? 'on' : 'off'}
          </button>
          <button onClick={() => setChatOpen(false)} className="text-muted hover:text-text" aria-label="Collapse">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        {chatMessages.length === 0 && (
          <p className="text-xs text-muted/60 text-center mt-4">Ask the assistant to analyze your data.</p>
        )}
        {chatMessages.map((m, i) => (
          <div key={i} className={`max-w-[92%] rounded px-2.5 py-1.5 text-xs whitespace-pre-wrap break-words ${ROLE_STYLE[m.role]}`}>
            {m.role === 'tool' ? `▸ ${m.text}` : m.text}
          </div>
        ))}
        {chatBusy && !chatPending && <div className="text-[10px] text-muted/60 italic">thinking…</div>}

        {chatPending && (
          <div className="border border-warn/40 bg-warn/10 rounded p-2 flex flex-col gap-2">
            <div className="text-[11px] text-text">
              Approve <span className="font-mono text-warn">{chatPending.name}</span>?
            </div>
            <pre className="text-[10px] font-mono text-muted bg-bg rounded p-2 overflow-x-auto max-h-32">
              {JSON.stringify(chatPending.params, null, 2)}
            </pre>
            {editing && (
              <textarea
                rows={4}
                value={editParams}
                onChange={(e) => setEditParams(e.target.value)}
                className="w-full bg-bg border border-border rounded px-2 py-1 text-[10px] font-mono text-text"
              />
            )}
            <input
              type="text"
              placeholder="reason (optional, for deny)"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              className="w-full bg-bg border border-border rounded px-2 py-1 text-[10px] text-text placeholder:text-muted/40"
            />
            <div className="flex gap-1">
              <button onClick={() => resolve('approve')} className="flex-1 py-1 text-[11px] text-white rounded" style={{ background: '#3d9970' }}>Approve</button>
              {!editing ? (
                <button onClick={() => { setEditing(true); setEditParams(JSON.stringify(chatPending.params, null, 2)); }} className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent">Edit</button>
              ) : (
                <button onClick={() => resolve('edit')} className="flex-1 py-1 text-[11px] bg-accent/20 text-accent rounded">Run edited</button>
              )}
              <button onClick={() => resolve('deny')} className="flex-1 py-1 text-[11px] bg-danger/15 text-danger rounded hover:bg-danger/25">Deny</button>
            </div>
          </div>
        )}
      </div>

      <div className="p-2 border-t border-border shrink-0 flex gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={chatBusy ? 'waiting…' : 'Ask the assistant…'}
          disabled={chatBusy}
          className="flex-1 bg-bg border border-border rounded px-2 py-1.5 text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent disabled:opacity-50"
        />
        <button onClick={send} disabled={chatBusy || !input.trim()} className="px-3 py-1.5 text-xs bg-accent hover:bg-accent/80 disabled:opacity-40 text-white rounded transition-colors">Send</button>
      </div>
    </aside>
  );
}
