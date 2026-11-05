import { useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { login } from '../chat/auth';

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
      setPassword('');
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-black text-zinc-100 relative w-full">
      <div className="grain-overlay" />
      <form
        onSubmit={submit}
        className="relative z-10 flex flex-col gap-4 w-full max-w-sm px-6"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center w-12 h-12 rounded-xl avatar-bot">
            <Bot size={24} className="text-zinc-100" />
          </div>
          <h1 className="text-lg font-semibold">CodeMode Agent</h1>
          <p className="text-sm text-zinc-500">
            Enter your password to continue.
          </p>
        </div>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="input-field rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
        />
        {error && (
          <div className="px-3 py-2 rounded-lg error-message text-red-400 text-xs">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={!password || busy}
          className="send-button rounded-xl px-4 py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          Sign in
        </button>
      </form>
    </div>
  );
}
