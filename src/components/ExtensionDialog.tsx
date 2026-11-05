import { useEffect, useState } from 'react';
import { MessageSquareQuote } from 'lucide-react';
import type { DialogRequest } from '../../server/gateway/protocol';

export type DialogAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

interface ExtensionDialogProps {
  dialog: DialogRequest;
  /** Other questions waiting behind this one. */
  queued: number;
  onRespond: (answer: DialogAnswer) => void;
}

const SECONDARY =
  'px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors text-sm font-medium text-zinc-100';

/**
 * One extension question at a time. Closing it (Escape, Cancel) is a denial:
 * it sends `cancelled`, which Pi treats as "no" / undefined. Nothing is ever
 * approved implicitly. Mount with `key={dialog.dialogId}` so state resets.
 */
export function ExtensionDialog({
  dialog,
  queued,
  onRespond,
}: ExtensionDialogProps) {
  const [text, setText] = useState(dialog.prefill ?? '');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!dialog.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [dialog.expiresAt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onRespond({ cancelled: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRespond]);

  const remaining = dialog.expiresAt
    ? Math.max(0, Math.ceil((dialog.expiresAt - now) / 1000))
    : null;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4"
      role="dialog"
      aria-modal="true"
      aria-label={dialog.title}
    >
      <div className="bg-zinc-900 rounded-lg shadow-lg w-full max-w-md border border-zinc-800">
        <div className="flex items-center gap-2 px-6 py-4 border-b border-zinc-800">
          <MessageSquareQuote size={18} className="text-teal-400 shrink-0" />
          <h2 className="text-base font-semibold text-zinc-100 wrap-break-words">
            {dialog.title}
          </h2>
        </div>

        <div className="px-6 py-5 flex flex-col gap-4">
          {dialog.message && (
            <p className="text-sm text-zinc-300 whitespace-pre-wrap wrap-break-words">
              {dialog.message}
            </p>
          )}

          {dialog.method === 'select' && (
            <div className="flex flex-col gap-2">
              {dialog.options?.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => onRespond({ value: option })}
                  className={`${SECONDARY} text-left`}
                >
                  {option}
                </button>
              ))}
            </div>
          )}

          {dialog.method === 'input' && (
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRespond({ value: text });
              }}
              placeholder={dialog.placeholder}
              className="input-field rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
            />
          )}

          {dialog.method === 'editor' && (
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              className="input-field rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 focus:outline-none resize-y"
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-zinc-800">
          <span className="text-xs text-zinc-500">
            {remaining !== null && `Auto-denies in ${remaining}s`}
            {remaining !== null && queued > 0 && ' · '}
            {queued > 0 && `${queued} more waiting`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onRespond(
                  dialog.method === 'confirm'
                    ? { confirmed: false }
                    : { cancelled: true }
                )
              }
              className={SECONDARY}
            >
              {dialog.method === 'confirm' ? 'Deny' : 'Cancel'}
            </button>
            {dialog.method === 'confirm' && (
              <button
                type="button"
                onClick={() => onRespond({ confirmed: true })}
                className="px-4 py-2 rounded-lg send-button text-sm font-medium"
              >
                Allow
              </button>
            )}
            {(dialog.method === 'input' || dialog.method === 'editor') && (
              <button
                type="button"
                onClick={() => onRespond({ value: text })}
                className="px-4 py-2 rounded-lg send-button text-sm font-medium"
              >
                Submit
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
