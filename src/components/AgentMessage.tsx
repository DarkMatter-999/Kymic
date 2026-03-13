import { Copy, Check, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ReasoningBlock } from './ReasoningBlock';
import { ToolCallBlock } from './ToolCallBlock';

interface MessagePart {
  type: string;
  text?: string;
  delta?: string;
  reasoning?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface AgentMessageProps {
  message: {
    parts: MessagePart[];
    id?: string;
  };
  messageIndex?: number;
  onRegenerate?: (messageIndex: number) => void;
}

export function AgentMessage({
  message,
  messageIndex,
  onRegenerate,
}: AgentMessageProps) {
  const [isCopied, setIsCopied] = useState(false);

  const hasContent = message.parts.some(
    (p) =>
      p.type === 'text' ||
      p.type?.includes('reasoning') ||
      p.type.includes('tool-')
  );

  if (!hasContent) {
    return null;
  }

  const textContent = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('');

  const handleCopy = async () => {
    await navigator.clipboard.writeText(textContent);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-1 max-w-[85%] items-start w-full">
      {message.parts.map((part, idx) => {
        {
          /* Reasoning Accordion */
        }
        if (part.type?.includes('reasoning')) {
          const reasoningContent =
            part.delta || part.text || part.reasoning || '';
          if (!reasoningContent) return null;
          return <ReasoningBlock key={idx} content={reasoningContent} />;
        }

        {
          /* Tool Results */
        }
        if (part.type.includes('tool-')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return <ToolCallBlock key={idx} content={part as any} />;
        }

        {
          /* Main Text Bubble */
        }
        if (part.type === 'text' && part.text) {
          return (
            <div key={idx} className="flex flex-col items-start w-full">
              <div className="px-4 py-3 rounded-2xl text-sm leading-relaxed message-bubble-assistant rounded-tl-sm w-full">
                <div className="prose prose-invert prose-sm max-w-none prose-p:my-1 prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-800 markdown-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {textContent}
                  </ReactMarkdown>
                </div>
              </div>

              <div className="flex items-center mt-1 px-1 gap-1">
                <button
                  onClick={handleCopy}
                  className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-full transition-all"
                  title="Copy message"
                >
                  {isCopied ? (
                    <Check size={16} className="text-teal-300" />
                  ) : (
                    <Copy size={16} />
                  )}
                </button>
                {messageIndex !== undefined && onRegenerate && (
                  <button
                    onClick={() => onRegenerate(messageIndex)}
                    className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-full transition-all"
                    title="Regenerate message"
                  >
                    <RotateCcw size={16} />
                  </button>
                )}
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
