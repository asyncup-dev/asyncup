import type { Verification } from '../lib/api';

export type VerifyState = { status: 'idle' } | { status: 'checking' } | { status: 'done'; result: Verification } | { status: 'error'; message: string };

/** The one live-check readout every setup gate uses: idle, checking, pass, fail. */
export function VerifyStatus({ state, idle = 'Not checked yet.' }: { state: VerifyState; idle?: string }) {
  if (state.status === 'idle') return <div className="verify verify-idle" role="status">{idle}</div>;
  if (state.status === 'checking') return <div className="verify verify-checking" role="status">Checking…</div>;
  if (state.status === 'error') return <div className="verify verify-fail" role="status">Could not check: {state.message}</div>;
  const pass = state.result.state === 'pass';
  return (
    <div className={`verify ${pass ? 'verify-pass' : 'verify-fail'}`} role="status">
      <strong>{pass ? 'Verified' : 'Not yet'}</strong> · {state.result.detail}
    </div>
  );
}

export function fromMutation(m: { isPending: boolean; isError: boolean; error: Error | null; data: Verification | undefined }): VerifyState {
  if (m.isPending) return { status: 'checking' };
  if (m.isError) return { status: 'error', message: m.error?.message ?? 'unknown error' };
  if (m.data) return { status: 'done', result: m.data };
  return { status: 'idle' };
}
