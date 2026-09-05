import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/context.jsx';
import { useDarkMode } from '../lib/hooks.js';
import { Btn, ErrorNote, Field, Input } from '../components/ui.jsx';

export default function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { dark, toggle: toggleDark } = useDarkMode();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={user.role === 'admin' ? '/admin' : '/field/start'} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await login(code.trim(), password);
      const intended = location.state?.from;
      const home = u.role === 'admin' ? '/admin' : '/field/start';
      const allowed = intended && (u.role === 'admin' ? intended.startsWith('/admin') : intended.startsWith('/field'));
      navigate(allowed ? intended : home, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
      {/* The product statement — ink panel, no decoration. */}
      <section className="hidden lg:flex flex-col justify-between bg-ink px-12 py-14 text-paper">
        <div>
          <p className="text-[13px] font-medium uppercase tracking-[0.18em] text-paper/60">Field Ledger</p>
          <h1 className="mt-8 max-w-md text-[34px] font-semibold leading-[1.15] tracking-tight">
            Every rupee and every invoice, traceable.
          </h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-paper/70">
            Salesmen log delivery, collection, cancellation and shortage from the shop counter.
            The back office sees what is expected, what is collected, and exactly what is outstanding.
          </p>
        </div>

        <div className="max-w-md">
          <p className="text-[12px] uppercase tracking-wider text-paper/50">The whole product, in one line</p>
          <pre className="num mt-3 whitespace-pre-wrap rounded-lg border border-paper/15 bg-paper/5 p-4 text-[13px] leading-relaxed text-paper/90">
{`Expected = Bills − Cancelled − Short
Actual   = Cash + Online + Cheque + Credit note
Variance = Expected − Actual`}
          </pre>
        </div>
      </section>

      <section className="flex items-center justify-center px-5 py-8 sm:px-10 sm:py-10">
        <div className="anim-rise w-full max-w-sm">
          <div className="flex items-center justify-between mb-6">
            <div className="lg:hidden">
              <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-ink-faint">Field Ledger</p>
              <h1 className="mt-1 text-[24px] font-semibold tracking-tight sm:text-[26px]">Sign in</h1>
            </div>
            <button
              type="button"
              onClick={toggleDark}
              className="h-10 w-10 flex items-center justify-center rounded-lg text-ink-faint hover:text-ink hover:bg-surface transition-colors"
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {dark ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
            </button>
          </div>
          <h1 className="hidden lg:block text-[26px] font-semibold tracking-tight mb-1">Sign in</h1>
          <p className="text-[14px] text-ink-soft mb-6">Use the login code your office gave you.</p>

          <form onSubmit={submit} className="space-y-4">
            <Field label="Login code">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="SLM-01"
                className="uppercase placeholder:normal-case"
                mono
                required
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
                required
              />
            </Field>

            <ErrorNote>{error}</ErrorNote>

            <Btn type="submit" variant="primary" size="lg" block disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Btn>
          </form>

          <p className="mt-8 text-[12.5px] text-ink-faint">
            Lost your login? Ask the back office to reset it.
          </p>
        </div>
      </section>
    </div>
  );
}
