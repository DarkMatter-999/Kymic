import { Copy, Check } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ReasoningBlock } from './ReasoningBlock';
import { ToolOutputBlock } from './ToolOutputBlock';

interface AgentMessageProps {
  textContent: string;
  reasoningContent: string;
  toolOutputParts: Array<{
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }>;
}

export function AgentMessage({
  textContent,
  reasoningContent,
  toolOutputParts,
}: AgentMessageProps) {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(textContent);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-1 max-w-[85%] items-start w-full">
      {/* Reasoning Accordion */}
      {reasoningContent && <ReasoningBlock content={reasoningContent} />}

      {/* Tool Output Results */}
      {toolOutputParts.length > 0 &&
        toolOutputParts.map((part, idx) => (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          <ToolOutputBlock key={idx} content={part as any} />
        ))}

      {/* Main Text Bubble */}
      {textContent && (
        <div className="flex flex-col items-start w-full">
          <div className="px-4 py-3 rounded-2xl text-sm leading-relaxed w-fit message-bubble-assistant rounded-tl-sm">
            <div className="prose prose-invert prose-sm max-w-none prose-p:my-1 prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-800">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {textContent}
              </ReactMarkdown>
            </div>
          </div>

          <div className="flex items-center mt-1 px-1">
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
          </div>
        </div>
      )}
    </div>
  );
}
