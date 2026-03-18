import { Zap, X, Loader2 } from 'lucide-react';

interface Subagent {
  id: string;
  status: string;
  task?: string;
  text?: string;
  result?: string;
}

interface SubagentsSidebarProps {
  subagents: Record<string, Subagent>;
  onClose: () => void;
}

export function SubagentsSidebar({
  subagents,
  onClose,
}: SubagentsSidebarProps) {
  const hasActiveSubagents = Object.values(subagents).some(
    (agent) => agent.status !== 'finished'
  );

  return (
    <aside className="hidden md:flex flex-col w-1/2 lg:w-1/3 h-full bg-zinc-950/95 backdrop-blur-md z-10 shrink-0 border-l border-zinc-900 transition-all">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-900 header-gradient shrink-0">
        <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <Zap
            size={20}
            className={hasActiveSubagents ? 'text-yellow-500' : 'text-teal-500'}
          />
          Active Subagents
        </h2>

        <div className="flex items-center gap-1">
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            title="Close Panel"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto h-full w-full custom-scrollbar relative">
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
      </div>
    </aside>
  );
}
