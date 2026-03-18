import { useChat } from '@ai-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Send,
  Bot,
  User,
  Loader2,
  Settings,
  Square,
  Zap,
  Layout,
  X,
  Printer,
  Download,
  Copy,
  Check,
} from 'lucide-react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai';

import './App.css';
import { SettingsModal } from './components/SettingsModal';
import { UserMessage } from './components/UserMessage';
import { AgentMessage } from './components/AgentMessage';

function App() {
  const [conversationId] = useState(() => uuidv4());

  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: { conversationId },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [subagents, setSubagents] = useState<Record<string, any>>({});

  // Right Panel State
  const [activeRightPanel, setActiveRightPanel] = useState<
    'subagents' | 'canvas' | null
  >(null);

  // Canvas State
  const [canvasData, setCanvasData] = useState({ html: '', css: '', js: '' });
  const [isCanvasCopied, setIsCanvasCopied] = useState(false);
  const canvasIframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const ws = new WebSocket(
      `ws://${window.location.hostname}:3000?conversationId=${conversationId}`
    );

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'canvas_update') {
          setCanvasData(data.content || { html: '', css: '', js: '' });
          setActiveRightPanel('canvas');
        } else if (data.type?.startsWith('subagent_')) {
          setSubagents((prev) => {
            const current = prev[data.subagentId] || {
              id: data.subagentId,
              status: 'started',
              text: '',
            };

            let newStatus = current.status;
            let newText = current.text;
            let newResult = current.result;

            if (data.type === 'subagent_started') newStatus = 'running';
            if (data.type === 'subagent_update') newText = data.text;
            if (data.type === 'subagent_tool_start') newStatus = 'tool_call';
            if (data.type === 'subagent_finished') {
              newStatus = 'finished';
              newResult = data.result;
            }
            if (data.type === 'subagent_error') {
              newStatus = 'error';
              newResult = data.error;
            }

            return {
              ...prev,
              [data.subagentId]: {
                ...current,
                status: newStatus,
                text: newText,
                result: newResult,
                task: data.task || current.task,
              },
            };
          });
        }
      } catch (err) {
        console.error('Failed to parse WS message', err);
      }
    };

    return () => ws.close();
  }, [conversationId]);

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

  const submit = async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    await sendMessage({ role: 'user', parts: [{ type: 'text', text }] });
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

  const handleRegenerate = async (messageIndex: number) => {
    const messageToRegenerate = messages[messageIndex];
    if (!messageToRegenerate || messageToRegenerate.role !== 'assistant')
      return;

    setTruncateAt(null);

    let lastUserMessageIndex = -1;
    for (let i = messageIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserMessageIndex = i;
        break;
      }
    }

    if (lastUserMessageIndex === -1) return;

    const lastUserMessage = messages[lastUserMessageIndex];
    const userText = lastUserMessage.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join('');

    await sendMessage({
      messageId: lastUserMessage.id,
      text: userText,
    });
  };

  const getFullCanvasHtml = () => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      ${canvasData.css || ''}
    </style>
  </head>
  <body>
    ${canvasData.html || ''}
    <script>
      try {
        ${canvasData.js || ''}
      } catch (err) {
        console.error('Canvas JS Error:', err);
      }
    </script>
  </body>
</html>`;

  const handlePrintCanvas = () => {
    if (canvasIframeRef.current?.contentWindow) {
      canvasIframeRef.current.contentWindow.print();
    }
  };

  const handleDownloadCanvas = () => {
    const html = getFullCanvasHtml();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'canvas-export.html';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyCanvas = async () => {
    const html = getFullCanvasHtml();
    try {
      await navigator.clipboard.writeText(html);
      setIsCanvasCopied(true);
      setTimeout(() => setIsCanvasCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard', err);
    }
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
                {isLoading ? (
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
              {Object.keys(subagents).length > 0 && (
                <span
                  className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${Object.values(subagents).some((agent) => agent.status !== 'finished') ? 'bg-yellow-500/20 text-yellow-500' : 'bg-teal-500/20 text-teal-500 '}`}
                >
                  {Object.keys(subagents).length}
                </span>
              )}
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
                  <AgentMessage
                    message={message}
                    messageIndex={messageIndex}
                    onRegenerate={handleRegenerate}
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
            {isLoading ? (
              <button
                type="button"
                onClick={() => stop()}
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
                disabled={isLoading || !input.trim()}
                className="shrink-0 flex items-center justify-center w-11 h-11 rounded-xl send-button disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed"
              >
                <Send size={18} color="currentColor" />
              </button>
            )}
          </div>
        </footer>
      </div>

      {/* Right Pane (Subagents / Canvas) */}
      {activeRightPanel && (
        <aside className="hidden md:flex flex-col w-1/2 lg:w-1/3 h-full bg-zinc-950/95 backdrop-blur-md z-10 shrink-0 border-l border-zinc-900 transition-all">
          <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-900 header-gradient shrink-0">
            {activeRightPanel === 'subagents' && (
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Zap
                  size={20}
                  className={
                    Object.values(subagents).some(
                      (agent) => agent.status !== 'finished'
                    )
                      ? 'text-yellow-500'
                      : 'text-teal-500'
                  }
                />
                Active Subagents
              </h2>
            )}
            {activeRightPanel === 'canvas' && (
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Layout size={20} className="text-indigo-400" />
                Interactive Canvas
              </h2>
            )}

            <div className="flex items-center gap-1">
              {activeRightPanel === 'canvas' && (
                <>
                  <button
                    onClick={handlePrintCanvas}
                    className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                    title="Print Canvas"
                  >
                    <Printer size={16} />
                  </button>
                  <button
                    onClick={handleDownloadCanvas}
                    className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                    title="Download Code"
                  >
                    <Download size={16} />
                  </button>
                  <button
                    onClick={handleCopyCanvas}
                    className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                    title="Copy Full Code"
                  >
                    {isCanvasCopied ? (
                      <Check size={16} className="text-teal-400" />
                    ) : (
                      <Copy size={16} />
                    )}
                  </button>
                  <div className="w-px h-4 bg-zinc-800 mx-2" />
                </>
              )}
              <button
                onClick={() => setActiveRightPanel(null)}
                className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                title="Close Panel"
              >
                <X size={18} />
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto h-full w-full custom-scrollbar relative">
            {activeRightPanel === 'subagents' && (
              <div className="p-4 space-y-4">
                {Object.values(subagents).length === 0 ? (
                  <div className="text-zinc-500 text-sm text-center mt-10">
                    No active subagents.
                  </div>
                ) : (
                  Object.values(subagents).map((agent) => (
                    <div
                      key={agent.id}
                      className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-4 flex flex-col gap-3 shadow-lg transition-all"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {agent.status === 'running' ||
                          agent.status === 'tool_call' ? (
                            <Loader2
                              size={14}
                              className="text-yellow-500 animate-spin"
                            />
                          ) : (
                            <Zap
                              size={14}
                              className={
                                agent.status === 'finished'
                                  ? 'text-teal-500'
                                  : 'text-red-500'
                              }
                            />
                          )}
                          <span className="text-xs font-semibold text-zinc-200">
                            ID: {agent.id.slice(0, 8)}
                          </span>
                        </div>
                        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 rounded bg-zinc-800 text-zinc-400">
                          {agent.status.replace('_', ' ')}
                        </span>
                      </div>

                      {agent.task && (
                        <div className="text-xs text-zinc-300 leading-relaxed border-l-2 border-zinc-700 pl-3 py-1">
                          {agent.task}
                        </div>
                      )}

                      {agent.status !== 'finished' && agent.text && (
                        <div className="text-xs text-zinc-500 font-mono truncate bg-zinc-950/50 p-2 rounded border border-zinc-800">
                          {agent.text}
                        </div>
                      )}

                      {agent.status === 'finished' && agent.result && (
                        <div className="mt-2 bg-zinc-950 p-3 rounded-lg text-xs text-zinc-300 font-mono whitespace-pre-wrap max-h-64 overflow-y-auto custom-scrollbar border border-zinc-800 shadow-inner">
                          {agent.result}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {activeRightPanel === 'canvas' && (
              <div className="w-full h-full bg-white relative">
                <iframe
                  ref={canvasIframeRef}
                  title="Interactive Canvas"
                  className="w-full h-full border-none"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                  srcDoc={getFullCanvasHtml()}
                />
              </div>
            )}
          </div>
        </aside>
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />
    </div>
  );
}

export default App;
