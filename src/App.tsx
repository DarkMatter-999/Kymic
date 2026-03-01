import { useChat } from '@ai-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { DefaultChatTransport } from 'ai';

import './App.css';
import { ReasoningBlock } from './components/ReasoningBlock';

function App() {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isLoading = status === 'streaming' || status === 'submitted';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    sendMessage({ role: 'user', parts: [{ type: 'text', text }] });
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
    <div className="flex flex-col h-screen bg-black text-zinc-100">
      {/* Header */}
      <header className="flex items-center gap-3 px-6 py-4 border-b border-zinc-900 bg-black shrink-0">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800">
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
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800">
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

        {messages.map((message) => {
          const isUser = message.role === 'user';
          const textContent = message.parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text || '')
            .join('');

          const reasoningContent = message.parts
            .filter((p) => p.type?.includes('reasoning'))
            .map((p) => p.delta || p.text || p.reasoning || '')
            .join('');

          if (!textContent && !reasoningContent) return null;

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
                  isUser
                    ? 'bg-zinc-100 text-black'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-100'
                }`}
              >
                {isUser ? (
                  <User size={15} color="currentColor" />
                ) : (
                  <Bot size={15} color="currentColor" />
                )}
              </div>

              {/* Bubble Container */}
              <div
                className={`flex flex-col gap-2 max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}
              >
                {/* Reasoning Accordion */}
                {!isUser && reasoningContent && (
                  <ReasoningBlock content={reasoningContent} />
                )}

                {/* Main Text Bubble */}
                {textContent && (
                  <div
                    className={`px-4 py-3 rounded-2xl text-sm leading-relaxed w-full ${
                      isUser
                        ? 'bg-zinc-800 text-zinc-100 rounded-tr-sm'
                        : 'bg-transparent text-zinc-300 rounded-tl-sm'
                    }`}
                  >
                    {isUser ? (
                      <p className="whitespace-pre-wrap">{textContent}</p>
                    ) : (
                      <div className="prose prose-invert prose-sm max-w-none prose-p:my-1 prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-800">
                        <ReactMarkdown>{textContent}</ReactMarkdown>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Streaming indicator */}
        {isLoading &&
          (messages.length === 0 ||
            messages[messages.length - 1]?.role !== 'assistant') && (
            <div className="flex items-start gap-3 max-w-3xl mx-auto">
              <div className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-100 mt-1">
                <Bot size={15} color="currentColor" />
              </div>
              <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-transparent">
                <Loader2 size={16} className="text-zinc-500 animate-spin" />
              </div>
            </div>
          )}

        {/* Error */}
        {error && (
          <div className="max-w-3xl mx-auto px-4 py-3 rounded-xl bg-red-950/20 border border-red-900/50 text-red-400 text-sm">
            {error.message ?? 'Something went wrong. Please try again.'}
          </div>
        )}

        <div ref={bottomRef} />
      </main>

      {/* Input */}
      <footer className="px-4 py-4 border-t border-zinc-900 bg-black shrink-0">
        <div className="flex items-end gap-3 max-w-3xl mx-auto">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Message Agent... (Shift+Enter for newline)"
            rows={1}
            className="flex-1 resize-none bg-zinc-900/50 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-teal-500/50 focus:ring-1 focus:ring-teal-500/50 transition-all overflow-y-auto"
            disabled={isLoading}
          />
          <button
            type="button"
            onClick={submit}
            disabled={isLoading || !input.trim()}
            className="shrink-0 flex items-center justify-center w-11 h-11 rounded-xl bg-teal-500 text-black hover:bg-teal-400 disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed transition-all"
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
    </div>
  );
}

export default App;
