import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/context.jsx';
import { api } from '../lib/api.js';
import { Btn, ErrorNote, Field, Input } from '../components/ui.jsx';

/**
 * Forced password rotation. Shown when the signed-in account still carries a
 * provisioned password (must_change_password). The API refuses every other
 * route until this completes, so the screen is the only place the session
 * can go; after success the context refreshes and the app opens normally.
 */
export default function RotatePassword() {
  const { user, setUser } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!user) return <Navigate to="/login" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('The two new passwords do not match. Re-enter them.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/password', { current_password: current, new_password: next });
      // Flag cleared server-side; refresh the local copy so guards open up.
      setUser({ ...user, must_change_password: 0 });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-surface px-5 py-10">
      <div className="w-full max-w-sm anim-rise">
        <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-ink-faint">Field Ledger</p>
        <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-ink">Set your own password</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          Your account starts with an office-issued password. Choose a new one before
          using the app — nothing else works until you do.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-5">
          <Field label="Current password" hint="The one the office gave you.">
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password" hint="At least 6 characters. Avoid the old defaults.">
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={6}
              required
            />
          </Field>
          <Field label="Repeat new password">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={6}
              required
            />
          </Field>

          <ErrorNote>{error}</ErrorNote>

          <Btn type="submit" variant="primary" size="lg" block disabled={busy}>
            {busy ? 'Saving…' : 'Save password'}
          </Btn>
        </form>
      </div>
    </div>
  );
}
