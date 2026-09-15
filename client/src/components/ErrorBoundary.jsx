import { Component } from 'react';
import { Btn, cx } from './ui.jsx';
import { reportError } from '../lib/errorReport.js';

/* Global error boundary. A render crash anywhere in the tree used to take the
   whole app down to a blank page — on a field phone with no console, that is a
   lost entry. This catches it, logs it, and offers reload / go home. */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Ship to the server-side sink (error_reports table) — field phones have
    // no console, so without this a crash is invisible to the operator.
    reportError(error, { kind: 'react_render', componentStack: info?.componentStack });
    console.error('Unhandled UI error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="min-h-dvh flex items-center justify-center bg-surface px-6">
        <div className="w-full max-w-md text-center">
          <p className="num text-[42px] font-medium text-line-strong">:(</p>
          <h1 className="mt-2 text-[20px] font-semibold text-ink">Something went wrong</h1>
          <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">
            The screen hit an error it couldn’t recover from. Your queued entries are safe —
            reload the page and continue.
          </p>
          <pre className="num mt-4 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-paper p-3 text-left text-[11.5px] text-attention-deep">
            {String(error?.message || error)}
          </pre>
          <div className={cx('mt-5 flex justify-center gap-2')}>
            <Btn
              variant="primary"
              onClick={() => window.location.reload()}
            >
              Reload the app
            </Btn>
            <Btn
              variant="ghost"
              onClick={() => { this.setState({ error: null }); window.location.assign('/'); }}
            >
              Go home
            </Btn>
          </div>
        </div>
      </div>
    );
  }
}
