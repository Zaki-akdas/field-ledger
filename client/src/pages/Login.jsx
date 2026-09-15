import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/context.jsx';
import { useDarkMode } from '../lib/hooks.js';
import { Btn, ErrorNote, Field, Input, cx } from '../components/ui.jsx';

export default function Login() {
  const { login, register, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { dark, toggle: toggleDark } = useDarkMode();
  const [mode, setMode] = useState('signin');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={user.role === 'admin' ? '/admin' : '/field/start'} replace />;

  const land = (u) => {
    const intended = location.state?.from;
    const home = u.role === 'admin' ? '/admin' : '/field/start';
    const allowed = intended && (u.role === 'admin' ? intended.startsWith('/admin') : intended.startsWith('/field'));
    navigate(allowed ? intended : home, { replace: true });
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signin') {
        land(await login(code.trim(), password));
      } else {
        land(await register({ code: code.trim(), name: name.trim(), password }));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh flex flex-col bg-surface">
      {/* Quiet top bar on mobile so the screen reads as a product, not a raw form. */}
      <header className="flex items-center justify-between border-b border-line px-4 py-3 lg:hidden">
        <div className="flex items-center gap-2">
          <span className="h-7 w-7 flex items-center justify-center rounded-md bg-ink text-paper" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-paper/80">
              <path d="M3 10h15M3 14h10M3 6h18" />
            </svg>
          </span>
          <span className="text-[13px] font-semibold tracking-tight text-ink">Field Ledger</span>
        </div>
        <button
          type="button"
          onClick={toggleDark}
          className="h-8 w-8 flex items-center justify-center rounded-lg text-ink-faint hover:text-ink hover:bg-paper transition-colors"
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {dark ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          )}
        </button>
      </header>

      <section className="flex-1 flex items-center justify-center px-5 py-8 sm:px-10 sm:py-10">
        <div className="anim-rise w-full max-w-sm">
          {/* Product lockup — hidden on desktop where the side panel carries it. */}
          <div className="mb-8 lg:hidden">
            <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-ink-faint">Field Ledger</p>
            <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-ink">
              {mode === 'signin' ? 'Sign in' : 'Create your login'}
            </h1>
          </div>

          <form onSubmit={submit} className="space-y-5">
            {/* Mode toggle — above the fields so switching feels like changing screens. */}
            <div className="flex rounded-lg border border-line bg-surface/60 p-0.5" role="tablist" aria-label="Sign in or create a login">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signin'}
                onClick={() => { setMode('signin'); setError(null); setCode(''); setPassword(''); setName(''); }}
                className={cx(
                  'flex-1 rounded-md px-3 py-2.5 text-[13.5px] font-medium transition-colors min-h-[44px] flex items-center justify-center',
                  mode === 'signin' ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper hover:text-ink'
                )}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signup'}
                onClick={() => { setMode('signup'); setError(null); setCode(''); setPassword(''); setName(''); }}
                className={cx(
                  'flex-1 rounded-md px-3 py-2.5 text-[13.5px] font-medium transition-colors min-h-[44px] flex items-center justify-center',
                  mode === 'signup' ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper hover:text-ink'
                )}
              >
                Create login
              </button>
            </div>

            <Field label="Login code" hint={mode === 'signup' ? '3-20 letters, numbers or dashes — e.g. RAMESH-S' : 'Your office gave you this.'}>
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
                autoFocus
              />
            </Field>

            {mode === 'signup' && (
              <Field label="Your name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  placeholder="Ramesh Yadav"
                  maxLength={60}
                  required
                />
              </Field>
            )}

            <Field label="Password" hint={mode === 'signup' ? 'At least 6 characters.' : undefined}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                placeholder="••••••••"
                minLength={mode === 'signup' ? 6 : undefined}
                required
              />
            </Field>

            <ErrorNote>{error}</ErrorNote>

            <Btn type="submit" variant="primary" size="lg" block disabled={busy}>
              {busy ? (mode === 'signin' ? 'Signing in…' : 'Creating…') : (mode === 'signin' ? 'Sign in' : 'Create login')}
            </Btn>
          </form>

          <p className="mt-6 text-center text-[13px] text-ink-soft">
            {mode === 'signin' ? (
              <>
                <button type="button" onClick={() => { setMode('signup'); setError(null); setCode(''); setPassword(''); setName(''); }} className="font-medium text-ink underline underline-offset-4 hover:opacity-80">
                  New salesman? Create your own login
                </button>
                <br />
                <span className="block mt-2 text-[12.5px] text-ink-faint">Lost your login? Ask the back office to reset it.</span>
              </>
            ) : (
              <button type="button" onClick={() => { setMode('signin'); setError(null); setCode(''); setPassword(''); setName(''); }} className="font-medium text-ink underline underline-offset-4 hover:opacity-80">
                Already have a login? Sign in
              </button>
            )}
          </p>

          {/* Footer hint — present on both modes so the screen doesn't feel naked. */}
          <p className="mt-5 text-[11.5px] text-ink-faint text-center">
            Signup creates field accounts only. Office logins are provisioned privately.
          </p>
        </div>
      </section>

      {/* Desktop side statement — mirrors the existing panel, but deliberately quiet. */}
      <section className="hidden lg:flex flex-col justify-between bg-ink px-12 py-14 text-paper" aria-hidden="true">
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
    </div>
  );
}
