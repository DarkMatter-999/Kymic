import { useState } from 'react';
import { ChevronDown, Zap, AlertCircle } from 'lucide-react';

interface ToolCall {
  type: string;
  toolCallId: string;
  output: {
    code?: string;
    result?: string | object;
    error?: string;
  };
  errorText?: string;
  input: {
    code?: string;
  };
}

export const ToolCallBlock = ({ content }: { content: ToolCall }) => {
  const [isOpen, setIsOpen] = useState(false);
  const output = content.output || {};
  const input = content.input || {};
  const hasError = !!content?.errorText?.length;

  return (
    <div className="flex flex-col w-full max-w-full mb-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 text-xs font-medium transition-all duration-200 w-fit select-none py-2 group ${
          hasError
            ? 'text-red-400 hover:text-red-300'
            : 'text-zinc-400 hover:text-teal-300'
        }`}
      >
        <Zap
          size={14}
          className={`transition-colors duration-200 ${
            hasError
              ? 'text-red-400 group-hover:text-red-300'
              : 'group-hover:text-teal-400 transition-colors duration-200 group-hover:drop-shadow-[0_0_8px_rgba(0,128,128,0.5)]'
          }`}
        />
        {hasError && <AlertCircle size={14} className="text-red-400" />}
        <span
          className={`bg-clip-text text-transparent transition-all duration-200 ${
            hasError
              ? 'bg-linear-to-r from-red-400 to-red-300'
              : 'bg-linear-to-r from-zinc-400 to-teal-300 group-hover:from-teal-300 group-hover:to-teal-200'
          }`}
        >
          {hasError ? 'Tool Error' : 'Tool Call'}
        </span>
        <ChevronDown
          size={14}
          className={`transition-transform duration-300 ${
            hasError ? 'group-hover:text-red-300' : 'group-hover:text-teal-400'
          } ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      <div
        className={`grid transition-all duration-300 ease-in-out ${
          isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="mt-2 space-y-3 relative">
            {/* Input Section */}
            {input.code && (
              <div className="pl-4 border-gradient-to-b from-teal-500/50 to-teal-500/10">
                <div className="text-teal-400 text-xs font-semibold mb-2">
                  Input Code
                </div>
                <div className="bg-zinc-900/50 p-3 rounded text-xs font-mono text-zinc-300 whitespace-pre-wrap wrap-break-words border border-zinc-800 relative">
                  {/* Subtle glow effect behind text */}
                  <div className="absolute -inset-2 bg-linear-to-r from-teal-500/5 via-transparent to-teal-500/5 rounded blur-sm pointer-events-none" />

                  <div className="relative z-10 hover:text-zinc-200 transition-colors duration-200">
                    {typeof input.code === 'string'
                      ? input.code
                      : JSON.stringify(input.code, null, 2)}
                  </div>
                </div>
              </div>
            )}

            {/* Error Section */}
            {hasError && (
              <div className="pl-4 border-gradient-to-b from-red-500/50 to-red-500/10">
                <div className="text-red-400 text-xs font-semibold mb-2 flex items-center gap-2">
                  <AlertCircle size={14} />
                  Tool Output Error
                </div>
                <div className="bg-red-950/30 p-3 rounded text-xs font-mono text-red-300 whitespace-pre-wrap wrap-break-words border border-red-800/50 relative">
                  <div className="absolute -inset-2 bg-linear-to-r from-red-500/5 via-transparent to-red-500/5 rounded blur-sm pointer-events-none" />

                  <div className="relative z-10 hover:text-red-200 transition-colors duration-200">
                    {content.errorText}
                  </div>
                </div>
              </div>
            )}

            {/* Result Section */}
            {output.result && !hasError && (
              <div className="pl-4 border-gradient-to-b from-teal-500/50 to-teal-500/10">
                <div className="text-teal-400 text-xs font-semibold mb-2">
                  Result
                </div>
                <div className="bg-zinc-900/50 p-3 rounded text-xs font-mono text-zinc-300 whitespace-pre-wrap wrap-break-words border border-zinc-800 relative">
                  {/* Subtle glow effect behind text */}
                  <div className="absolute -inset-2 bg-linear-to-r from-teal-500/5 via-transparent to-teal-500/5 rounded blur-sm pointer-events-none" />

                  <div className="relative z-10 hover:text-zinc-200 transition-colors duration-200">
                    {typeof output.result === 'string'
                      ? output.result
                      : JSON.stringify(output.result, null, 2)}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
