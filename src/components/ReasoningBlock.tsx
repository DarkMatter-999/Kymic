import { useState } from 'react';
import { ChevronDown, BrainCircuit } from 'lucide-react';

export const ReasoningBlock = ({ content }: { content: string }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="flex flex-col w-full max-w-full mb-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-xs font-medium text-zinc-500 hover:text-zinc-300 transition-colors w-fit select-none py-1"
      >
        <BrainCircuit size={14} />
        <span>Thought Process</span>
        <ChevronDown
          size={14}
          className={`transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* CSS Grid trick for smooth height animation */}
      <div
        className={`grid transition-all duration-300 ease-in-out ${
          isOpen
            ? 'grid-rows-[1fr] opacity-100 mt-2'
            : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="pl-4 border-l-2 border-zinc-800 text-xs text-zinc-500 font-mono whitespace-pre-wrap leading-relaxed break-words">
            {content}
          </div>
        </div>
      </div>
    </div>
  );
};
