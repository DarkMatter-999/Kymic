import { useChat } from '@ai-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { Send, Bot, User, Loader2, Settings } from 'lucide-react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai';

import './App.css';
import { SettingsModal } from './components/SettingsModal';
import { UserMessage } from './components/UserMessage';
import { AgentMessage } from './components/AgentMessage';

function App() {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [truncateAt, setTruncateAt] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isLoading = status === 'streaming' || status === 'submitted';

  const displayedMessages =
    truncateAt !== null ? messages.slice(0, truncateAt + 1) : messages;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayedMessages]);

  const submit = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    sendMessage({ role: 'user', parts: [{ type: 'text', text }] });
    setInput('');
    setTruncateAt(null);
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

  const handleEditMessage = (messageIndex: number, newContent: string) => {
    const messageToEdit = messages[messageIndex];
    if (!messageToEdit) return;

    setTruncateAt(null);

    sendMessage({
      messageId: messageToEdit.id,
      text: newContent,
    });

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  return (
    <div className="flex flex-col h-screen bg-black text-zinc-100 relative app-container">
      {/* Grain Overlay */}
      <div className="grain-overlay" />

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
              {isLoading ? (
                <span className="text-zinc-400 animate-pulse">Thinking...</span>
              ) : (
                'Ready'
              )}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-zinc-900 transition-colors shrink-0"
        >
          <Settings size={20} className="text-zinc-100" />
        </button>
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
          </div>
        )}

        {displayedMessages.map((message, messageIndex) => {
          const isUser = message.role === 'user';

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
                  onEdit={(newContent) =>
                    handleEditMessage(messageIndex, newContent)
                  }
                />
              ) : (
                <AgentMessage message={message} />
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
                  (p) => p.type.includes('tool-call')
                )
                  ? 'Running tools...'
                  : 'Thinking...'}
              </span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="max-w-3xl mx-auto px-4 py-3 rounded-xl error-message text-red-400 text-sm">
            {error.message ?? 'Something went wrong. Please try again.'}
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
          <button
            type="button"
            onClick={submit}
            disabled={isLoading || !input.trim()}
            className="shrink-0 flex items-center justify-center w-11 h-11 rounded-xl send-button disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <Loader2
                size={18}
                className="animate-spin"
                color="currentColor"
              />
            ) : (
              <Send size={18} color="currentColor" />
            )}
          </button>
        </div>
      </footer>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />
    </div>
  );
}

export default App;
