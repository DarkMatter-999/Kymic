import { useEffect, useRef, useState } from 'react';
import { useGatewayChat } from './chat/useGatewayChat';
import { checkSession, logout } from './chat/auth';
import { LoginScreen } from './components/LoginScreen';
import { ExtensionDialog } from './components/ExtensionDialog';
import {
  Send,
  Bot,
  User,
  Loader2,
  Settings,
  Square,
  Zap,
  Layout,
  CalendarClock,
  LogOut,
} from 'lucide-react';

import './App.css';
import { SettingsModal } from './components/SettingsModal';
import { UserMessage } from './components/UserMessage';
import { AgentMessage } from './components/AgentMessage';
import { SubagentsSidebar } from './components/SubagentsSidebar';
import { CanvasSidebar } from './components/CanvasSidebar';
import { ModelPicker } from './components/ModelPicker';
import { ProfilePicker } from './components/ProfilePicker';
import { SchedulesSidebar } from './components/SchedulesSidebar';

const CONVERSATION_KEY = 'codemode.conversationId';

// crypto.randomUUID needs a secure context; getRandomValues does not.
function newConversationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// One conversation per browser until a conversation list exists; persisting the ID
// lets a reload reconnect to the same Pi session instead of starting over.
function loadConversationId(): string {
  try {
    const existing = window.localStorage.getItem(CONVERSATION_KEY);
    if (existing) return existing;
    const created = newConversationId();
    window.localStorage.setItem(CONVERSATION_KEY, created);
    return created;
  } catch {
    return newConversationId();
  }
}

function ChatApp({ onSignOut }: { onSignOut: () => void }) {
  const [conversationId] = useState(loadConversationId);

  const {
    messages,
    sendMessage,
    running: isLoading,
    error,
    connected,
    stop,
    editMessage,
    regenerate,
    dialogs,
    notice,
    unsupported,
    respondDialog,
    dismissNotice,
    dismissUnsupported,
    canvas,
    canvasRevision,
    subagents,
    profile,
    model,
    setModel,
  } = useGatewayChat(conversationId);

  // Right Panel State
  const [activeRightPanel, setActiveRightPanel] = useState<
    'subagents' | 'canvas' | 'schedules' | null
  >(null);

  // Open the pane when the agent shows a canvas live (not when history reloads).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (canvasRevision > 0) setActiveRightPanel('canvas');
  }, [canvasRevision]);

  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const displayedMessages = messages;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayedMessages]);

  const [chosenProfile, setChosenProfile] = useState<string | undefined>();

  const submit = () => {
    const text = input.trim();
    if (!text || isLoading || !connected) return;
    if (!sendMessage(text, profile ? undefined : chosenProfile)) return;
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);

    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div className="flex h-screen bg-black text-zinc-100 relative app-container overflow-hidden w-full">
      {/* Grain Overlay */}
      <div className="grain-overlay" />

      {/* Main Chat Area (Left Pane) */}
      <div
        className={`flex flex-col h-full transition-all duration-300 w-full`}
      >
        {/* Header */}
        <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-zinc-900 header-gradient shrink-0 relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg avatar-bot">
              <Bot size={20} className="text-zinc-100" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-zinc-100">
                CodeMode Agent
              </h1>
              <p className="text-xs text-zinc-500">
                {!connected ? (
                  <span className="text-zinc-500 animate-pulse">
                    Reconnecting...
                  </span>
                ) : isLoading ? (
                  <span className="text-zinc-400 animate-pulse">
                    Thinking...
                  </span>
                ) : (
                  'Ready'
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ModelPicker
              compact
              value={model}
              disabled={isLoading || !connected}
              reloadKey={model?.id}
              onChange={(m) => {
                if (!setModel(m.provider, m.id))
                  throw new Error('Not connected');
              }}
            />
            <button
              type="button"
              onClick={() =>
                setActiveRightPanel((prev) =>
                  prev === 'canvas' ? null : 'canvas'
                )
              }
              className={`flex items-center justify-center h-9 px-3 rounded-lg hover:bg-zinc-900 transition-colors shrink-0 text-sm font-medium ${
                activeRightPanel === 'canvas'
                  ? 'bg-zinc-800 text-indigo-400'
                  : 'text-zinc-400'
              }`}
            >
              <Layout
                size={16}
                className={`mr-2 ${activeRightPanel === 'canvas' ? 'text-indigo-400' : 'text-zinc-400'}`}
              />
              Canvas
            </button>
            <button
              type="button"
              onClick={() =>
                setActiveRightPanel((prev) =>
                  prev === 'subagents' ? null : 'subagents'
                )
              }
              className={`flex items-center justify-center h-9 px-3 rounded-lg hover:bg-zinc-900 transition-colors shrink-0 text-sm font-medium ${
                activeRightPanel === 'subagents'
                  ? 'bg-zinc-800 text-teal-400'
                  : 'text-zinc-400'
              }`}
            >
              <Zap
                size={16}
                className={`mr-2 ${activeRightPanel === 'subagents' ? 'text-teal-400' : 'text-zinc-400'}`}
              />
              Subagents
              {subagents.length > 0 && (
                <span
                  className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${subagents.some((a) => a.state === 'running' || a.state === 'tool_call') ? 'bg-yellow-500/20 text-yellow-500' : 'bg-teal-500/20 text-teal-500 '}`}
                >
                  {subagents.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() =>
                setActiveRightPanel((prev) =>
                  prev === 'schedules' ? null : 'schedules'
                )
              }
              className={`flex items-center justify-center h-9 px-3 rounded-lg hover:bg-zinc-900 transition-colors shrink-0 text-sm font-medium ${
                activeRightPanel === 'schedules'
                  ? 'bg-zinc-800 text-teal-400'
                  : 'text-zinc-400'
              }`}
            >
              <CalendarClock
                size={16}
                className={`mr-2 ${activeRightPanel === 'schedules' ? 'text-teal-400' : 'text-zinc-400'}`}
              />
              Schedule
            </button>
            <button
              type="button"
              onClick={onSignOut}
              title="Sign out"
              className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-zinc-900 transition-colors shrink-0"
            >
              <LogOut size={18} className="text-zinc-400" />
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-zinc-900 transition-colors shrink-0"
            >
              <Settings size={20} className="text-zinc-100" />
            </button>
          </div>
        </header>

        {/* Messages */}
        <main className="flex-1 overflow-y-auto px-4 py-6 space-y-6 main-content relative z-10">
          {displayedMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center empty-state">
              <div className="flex items-center justify-center w-16 h-16 rounded-2xl empty-state-icon">
                <Bot size={32} className="text-zinc-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">
                  How can I help you?
                </h2>
                <p className="text-sm text-zinc-500 mt-1">
                  Start a conversation below.
                </p>
              </div>
              {profile === null && (
                <ProfilePicker
                  value={chosenProfile}
                  onChange={setChosenProfile}
                />
              )}
            </div>
          )}

          {displayedMessages.map((message, messageIndex) => {
            const isUser = message.role === 'user';
            // Forking needs Pi's real entry ID, so it is offered only once the
            // post-turn snapshot has supplied one and nothing is running.
            const canFork = connected && !isLoading;
            const entryId = message.entryId;
            let promptEntryId: string | undefined;
            for (let i = messageIndex - 1; i >= 0; i--) {
              if (displayedMessages[i].role === 'user') {
                promptEntryId = displayedMessages[i].entryId;
                break;
              }
            }

            if (message.parts.length === 0) return null;

            return (
              <div
                key={message.id}
                className={`flex items-start gap-3 max-w-3xl mx-auto ${
                  isUser ? 'flex-row-reverse' : 'flex-row'
                }`}
              >
                {/* Avatar */}
                <div
                  className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-full mt-1 ${
                    isUser ? 'avatar-user' : 'avatar-bot'
                  }`}
                >
                  {isUser ? (
                    <User size={15} color="currentColor" />
                  ) : (
                    <Bot size={15} color="currentColor" />
                  )}
                </div>

                {/* Message Bubble */}
                {isUser ? (
                  <UserMessage
                    message={message}
                    onEdit={
                      canFork && entryId
                        ? (text) => editMessage(entryId, text)
                        : undefined
                    }
                  />
                ) : (
                  <AgentMessage
                    message={message}
                    messageIndex={messageIndex}
                    onRegenerate={
                      canFork && promptEntryId
                        ? () => regenerate(promptEntryId)
                        : undefined
                    }
                  />
                )}
              </div>
            );
          })}

          {/* Streaming indicator */}
          {isLoading && (
            <div className="flex items-start gap-3 max-w-3xl mx-auto pb-4">
              <div className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full avatar-bot mt-1">
                <Bot size={15} color="currentColor" />
              </div>
              <div className="px-4 py-3 rounded-2xl rounded-tl-sm message-bubble-assistant flex items-center gap-2">
                <Loader2 size={16} className="text-zinc-500 animate-spin" />
                <span className="text-xs text-zinc-500 font-medium">
                  {displayedMessages[displayedMessages.length - 1]?.parts.some(
                    (p) => p.type.startsWith('tool-')
                  )
                    ? 'Running tools...'
                    : 'Thinking...'}
                </span>
              </div>
            </div>
          )}

          {/* Extension notices */}
          {notice && (
            <div
              className={`max-w-3xl mx-auto px-4 py-3 rounded-xl text-sm flex items-start justify-between gap-3 border ${
                notice.level === 'error'
                  ? 'border-red-800/50 text-red-400'
                  : notice.level === 'warning'
                    ? 'border-yellow-800/50 text-yellow-500'
                    : 'border-zinc-800 text-zinc-300'
              }`}
            >
              <span className="whitespace-pre-wrap wrap-break-words">
                {notice.message}
              </span>
              <button
                type="button"
                onClick={dismissNotice}
                className="text-xs text-zinc-500 hover:text-zinc-300 shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}
          {unsupported.length > 0 && (
            <div className="max-w-3xl mx-auto px-4 py-3 rounded-xl text-xs flex items-start justify-between gap-3 border border-zinc-800 text-zinc-500">
              <span>
                An extension used UI this app does not support:{' '}
                {unsupported.join(', ')}.
              </span>
              <button
                type="button"
                onClick={dismissUnsupported}
                className="text-zinc-500 hover:text-zinc-300 shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="max-w-3xl mx-auto px-4 py-3 rounded-xl error-message text-red-400 text-sm">
              {error}
            </div>
          )}

          <div ref={bottomRef} />
        </main>

        {/* Input */}
        <footer className="px-4 py-4 border-t border-zinc-900 footer-gradient shrink-0 relative z-10">
          <div className="flex items-end gap-3 max-w-3xl mx-auto">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Message Agent... (Shift+Enter for newline)"
              rows={1}
              className="flex-1 resize-none input-field rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none transition-all overflow-y-auto"
            />
            {isLoading ? (
              <button
                type="button"
                onClick={stop}
                className="shrink-0 flex items-center justify-center w-11 h-11 rounded-xl bg-zinc-700 hover:bg-zinc-800 transition-colors"
                title="Stop generation"
                key="stop-btn"
              >
                <Square size={18} className="text-red-500 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                key="send-btn"
                disabled={isLoading || !connected || !input.trim()}
                className="shrink-0 flex items-center justify-center w-11 h-11 rounded-xl send-button disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed"
              >
                <Send size={18} color="currentColor" />
              </button>
            )}
          </div>
        </footer>
      </div>

      {/* Right Pane (Subagents / Canvas) */}
      {activeRightPanel === 'subagents' && (
        <SubagentsSidebar
          subagents={subagents}
          onClose={() => setActiveRightPanel(null)}
        />
      )}

      {activeRightPanel === 'canvas' && (
        <CanvasSidebar
          canvasData={canvas ?? { html: '', css: '', js: '' }}
          onClose={() => setActiveRightPanel(null)}
        />
      )}

      {activeRightPanel === 'schedules' && (
        <SchedulesSidebar
          conversationId={conversationId}
          onClose={() => setActiveRightPanel(null)}
        />
      )}

      {dialogs[0] && (
        <ExtensionDialog
          key={dialogs[0].dialogId}
          dialog={dialogs[0]}
          queued={dialogs.length - 1}
          onRespond={(answer) => respondDialog(dialogs[0].dialogId, answer)}
        />
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />
    </div>
  );
}

const SESSION_POLL_MS = 60_000;

// Shows the login form until the server confirms a live session, and returns to it
// when the session expires. An unknown result (server unreachable) keeps the
// current state so a brief outage doesn't discard the chat.
function App() {
  const [session, setSession] = useState<'checking' | 'in' | 'out'>('checking');

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const result = await checkSession();
      if (!cancelled && result !== 'unknown') setSession(result);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), SESSION_POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  if (session === 'checking') return <div className="h-screen bg-black" />;
  if (session === 'out')
    return <LoginScreen onLoggedIn={() => setSession('in')} />;
  return (
    <ChatApp
      onSignOut={() => {
        void logout()
          .then(checkSession)
          .then((result) => setSession(result === 'in' ? 'in' : 'out'));
      }}
    />
  );
}

export default App;
