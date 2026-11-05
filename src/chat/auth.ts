export type SessionState = 'in' | 'out';

/** 'in' if the cookie session is live. Network errors count as unknown, not logged out. */
export async function checkSession(): Promise<SessionState | 'unknown'> {
  try {
    const response = await fetch('/api/auth/session');
    if (response.ok) return 'in';
    return response.status === 401 ? 'out' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function login(password: string): Promise<void> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (response.status === 204) return;
  if (response.status === 429) {
    const wait = response.headers.get('Retry-After');
    throw new Error(
      `Too many attempts. Try again${wait ? ` in ${wait} seconds` : ' later'}.`
    );
  }
  if (response.status === 503) {
    throw new Error('Login is not configured on the server.');
  }
  throw new Error(
    response.status === 401 ? 'Incorrect password.' : 'Login failed.'
  );
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => {});
}
