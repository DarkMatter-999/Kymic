import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, KeyRound, LogOut } from 'lucide-react';
import {
  foldLoginEvents,
  providersApi,
  type AuthType,
  type LoginEvent,
  type ProviderInfo,
} from '../chat/providers';

const BUTTON =
  'px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors text-xs font-medium text-zinc-100 disabled:opacity-40';

/** Sign in to model providers through Pi's own login flows. Secrets never leave the form. */
export function ProvidersPanel() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [active, setActive] = useState<{
    loginId: string;
    providerId: string;
  } | null>(null);
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');

  const refresh = useCallback(async () => {
    try {
      setProviders(await providersApi.list());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load providers');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Resume a login that is still running after a reload.
  useEffect(() => {
    void providersApi
      .current()
      .then((state) => {
        if (state?.status === 'running')
          setActive({ loginId: state.loginId, providerId: state.providerId });
      })
      .catch(() => undefined);
  }, []);

  const loginId = active?.loginId;
  useEffect(() => {
    if (!loginId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEvents([]);
    return providersApi.watch(loginId, (event) => {
      setEvents((prev) => [...prev, event]);
      if (event.type === 'done') void refresh();
    });
  }, [loginId, refresh]);

  const view = useMemo(() => foldLoginEvents(events), [events]);
  const finished = view.status !== 'running';

  const start = async (providerId: string, authType: AuthType) => {
    try {
      setError(null);
      setAnswer('');
      const state = await providersApi.start(providerId, authType);
      setActive({ loginId: state.loginId, providerId });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start sign-in');
    }
  };

  const respond = async (value: string | null) => {
    if (!active || !view.prompt) return;
    try {
      await providersApi.respond(
        active.loginId,
        view.prompt.promptId,
        value === null ? { cancelled: true } : { value }
      );
      setAnswer('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer');
    }
  };

  const name = providers.find((p) => p.id === active?.providerId)?.name;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-100">Model providers</h3>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {active && (
        <div className="rounded-lg border border-zinc-700 p-3 space-y-2 text-sm">
          <div className="font-medium text-zinc-100">
            Signing in to {name ?? active.providerId}
          </div>

          {view.link && (
            <a
              href={view.link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-teal-400 hover:underline"
            >
              Open the sign-in page <ExternalLink size={14} />
            </a>
          )}
          {view.link?.instructions && (
            <p className="text-xs text-zinc-400">{view.link.instructions}</p>
          )}
          {view.device && (
            <div className="text-xs text-zinc-300">
              Go to{' '}
              <a
                href={view.device.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-400 hover:underline"
              >
                {view.device.verificationUri}
              </a>{' '}
              and enter{' '}
              <code className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-100 select-all">
                {view.device.userCode}
              </code>
            </div>
          )}
          {view.notes.map((note, i) => (
            <p key={i} className="text-xs text-zinc-400">
              {note}
            </p>
          ))}

          {view.prompt && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (view.prompt?.kind !== 'secret' && !answer.trim()) return;
                void respond(answer);
              }}
            >
              <label className="block text-xs text-zinc-300">
                {view.prompt.message}
              </label>
              {view.prompt.kind === 'select' ? (
                <div className="flex flex-col gap-1.5">
                  {view.prompt.options?.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      className={`${BUTTON} text-left`}
                      onClick={() => void respond(o.id)}
                    >
                      {o.label}
                      {o.description && (
                        <span className="block text-zinc-400 font-normal">
                          {o.description}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  autoFocus
                  type={view.prompt.kind === 'secret' ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder={view.prompt.placeholder}
                  className="w-full input-field rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none"
                />
              )}
              {view.prompt.kind !== 'select' && (
                <button type="submit" className={BUTTON}>
                  Continue
                </button>
              )}
            </form>
          )}

          {view.status === 'done' && (
            <p className="text-xs text-teal-400 flex items-center gap-1">
              <Check size={14} /> Signed in. New conversations will use it.
            </p>
          )}
          {view.status === 'failed' && (
            <p role="alert" className="text-xs text-red-400">
              Sign-in failed: {view.error}
            </p>
          )}
          {view.status === 'cancelled' && (
            <p className="text-xs text-zinc-400">Sign-in cancelled.</p>
          )}

          <div className="flex gap-2">
            {finished ? (
              <button
                type="button"
                className={BUTTON}
                onClick={() => setActive(null)}
              >
                Dismiss
              </button>
            ) : (
              <button
                type="button"
                className={BUTTON}
                onClick={() =>
                  void providersApi
                    .cancel(active.loginId)
                    .catch((e: Error) => setError(e.message))
                }
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      <ul className="max-h-72 overflow-y-auto divide-y divide-zinc-800">
        {providers.map((p) => (
          <li key={p.id} className="flex items-center gap-2 py-2">
            <span className="flex-1 min-w-0 truncate text-sm text-zinc-200">
              {p.name}
              {p.configured && (
                <Check
                  size={14}
                  className="inline ml-1.5 text-teal-400"
                  aria-label="Signed in"
                />
              )}
            </span>
            {p.configured ? (
              <button
                type="button"
                title="Sign out"
                disabled={!!active && !finished}
                className={BUTTON}
                onClick={() =>
                  void providersApi
                    .logout(p.id)
                    .then(refresh)
                    .catch((e: Error) => setError(e.message))
                }
              >
                <LogOut size={14} className="inline" />
              </button>
            ) : (
              p.methods.map((m) => (
                <button
                  key={m.type}
                  type="button"
                  disabled={!!active && !finished}
                  className={BUTTON}
                  onClick={() => void start(p.id, m.type)}
                >
                  {m.type === 'api_key' && (
                    <KeyRound size={12} className="inline mr-1" />
                  )}
                  {m.type === 'oauth' ? 'Sign in' : 'API key'}
                </button>
              ))
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
