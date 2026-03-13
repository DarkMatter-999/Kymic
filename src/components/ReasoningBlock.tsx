import { useState } from 'react';
import { ChevronDown, BrainCircuit } from 'lucide-react';

export const ReasoningBlock = ({ content }: { content: string }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="flex flex-col w-full max-w-full mb-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-teal-300 transition-all duration-200 w-fit select-none py-2 relative z-10 group"
      >
        <BrainCircuit
          size={14}
          className="group-hover:text-teal-400 transition-colors duration-200 group-hover:drop-shadow-[0_0_8px_rgba(0,128,128,0.5)]"
        />
        <span className="bg-linear-to-r from-zinc-400 to-teal-300 bg-clip-text text-transparent group-hover:from-teal-300 group-hover:to-teal-200 transition-all duration-200">
          Thought Process
        </span>
        <ChevronDown
          size={14}
          className={`transition-transform duration-300 group-hover:text-teal-400 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      <div
        className={`grid transition-all duration-300 ease-in-out ${
          isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="mt-2 pl-4 border-l-2 border-gradient-to-b from-teal-500/50 to-teal-500/10 text-xs text-zinc-400 font-mono whitespace-pre-wrap leading-relaxed wrap-break-words relative">
            <div className="absolute -inset-2 bg-linear-to-r from-teal-500/5 via-transparent to-teal-500/5 rounded blur-sm pointer-events-none" />

            <div className="relative z-10 hover:text-zinc-300 transition-colors duration-200">
              {content}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
