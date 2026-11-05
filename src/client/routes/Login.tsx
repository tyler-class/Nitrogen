import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';

export function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  return (
    <main className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api.post('/login', { password });
            await qc.invalidateQueries({ queryKey: ['session'] });
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <h1>Nitrogen</h1>
        <label htmlFor="pw">Password</label>
        <input
          id="pw"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" disabled={busy || !password}>
          Sign in
        </button>
      </form>
    </main>
  );
}

export function SetupNeeded({ message }: { message: string }) {
  return (
    <main className="login">
      <div>
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <h1>Almost there</h1>
        <p>{message}</p>
      </div>
    </main>
  );
}
