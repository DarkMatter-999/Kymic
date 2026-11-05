import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, X, Trash2 } from 'lucide-react';
import {
  schedulesApi,
  type RunView,
  type ScheduleView,
} from '../chat/schedules';

interface SchedulesSidebarProps {
  conversationId: string;
  onClose: () => void;
}

const STATUS_STYLE: Record<string, string> = {
  completed: 'bg-teal-500/20 text-teal-400',
  running: 'bg-yellow-500/20 text-yellow-500',
  launching: 'bg-yellow-500/20 text-yellow-500',
  failed: 'bg-red-500/20 text-red-400',
  interrupted: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-zinc-700 text-zinc-300',
};

export function SchedulesSidebar({
  conversationId,
  onClose,
}: SchedulesSidebarProps) {
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [runs, setRuns] = useState<Record<string, RunView[]>>({});
  const [prompt, setPrompt] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await schedulesApi.list();
      setSchedules(list);
      const entries = await Promise.all(
        list.map(async (s) => [s.id, await schedulesApi.runs(s.id)] as const)
      );
      setRuns(Object.fromEntries(entries));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load schedules');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    }
  };

  const create = () =>
    act(async () => {
      await schedulesApi.create({
        conversationId,
        prompt: prompt.trim(),
        everyMs: minutes * 60_000,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setPrompt('');
    });

  return (
    <aside className="hidden md:flex flex-col w-1/2 lg:w-1/3 h-full bg-zinc-950/95 backdrop-blur-md z-10 shrink-0 border-l border-zinc-900 transition-all">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-900 header-gradient shrink-0">
        <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <CalendarClock size={20} className="text-teal-500" />
          Scheduled Tasks
        </h2>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          title="Close Panel"
        >
          <X size={18} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto h-full w-full custom-scrollbar">
        <div className="p-4 space-y-4">
          <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-4 flex flex-col gap-3">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Prompt to run in this conversation"
              rows={3}
              className="resize-none input-field rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
            />
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              Every
              <input
                type="number"
                min={1}
                value={minutes}
                onChange={(e) =>
                  setMinutes(Math.max(1, Number(e.target.value)))
                }
                className="w-20 input-field rounded-lg px-2 py-1 text-sm text-zinc-100 focus:outline-none"
              />
              minutes
            </label>
            <button
              onClick={create}
              disabled={!prompt.trim()}
              className="send-button rounded-lg px-3 py-2 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Create schedule
            </button>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg error-message text-red-400 text-xs">
              {error}
            </div>
          )}

          {schedules.length === 0 && !error && (
            <div className="text-zinc-500 text-sm text-center mt-6">
              No scheduled tasks.
            </div>
          )}

          {schedules.map((s) => (
            <div
              key={s.id}
              className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-4 flex flex-col gap-3"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm text-zinc-200 whitespace-pre-wrap wrap-break-words">
                  {s.prompt}
                </p>
                <button
                  onClick={() => act(() => schedulesApi.remove(s.id))}
                  className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors shrink-0"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span>
                  Every {Math.round(s.everyMs / 60_000)} min · next{' '}
                  {s.enabled
                    ? new Date(s.nextOccurrence).toLocaleTimeString()
                    : 'paused'}
                </span>
                <button
                  onClick={() =>
                    act(() => schedulesApi.setEnabled(s.id, !s.enabled))
                  }
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                >
                  {s.enabled ? 'Pause' : 'Resume'}
                </button>
              </div>
              {(runs[s.id] ?? []).slice(0, 5).map((r) => (
                <div
                  key={r.occurrenceId}
                  className="border-t border-zinc-800/80 pt-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">
                      {new Date(r.dueAt).toLocaleString()}
                    </span>
                    <span
                      className={`text-[10px] uppercase font-bold tracking-wider px-2 py-1 rounded ${
                        STATUS_STYLE[r.status] ?? 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {r.status.replace('_', ' ')}
                    </span>
                  </div>
                  {(r.error || r.result) && (
                    <p className="mt-1 text-zinc-400 line-clamp-3 whitespace-pre-wrap">
                      {r.error ?? r.result}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
