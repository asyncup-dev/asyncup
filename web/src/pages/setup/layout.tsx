import { Link, Navigate, Outlet } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { LogoLockup } from '../../components/logo';
import { useMe } from '../../lib/auth';
import { STEPS, stepDone, useSetupProgress, type SetupProgress } from '../../lib/setup';

/** Setup is admin-only; everyone else goes to their console. */
export function SetupGuard() {
  const me = useMe();
  if (me.isPending) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  if (!me.data) return <Navigate to="/sign-in" replace />;
  if (me.data.kind !== 'admin') return <Navigate to={me.data.kind === 'member' ? '/me' : '/standups'} replace />;
  return <Outlet />;
}

export function StepRail({ progress, currentId }: { progress: SetupProgress | undefined; currentId: string }) {
  const currentIndex = STEPS.findIndex((s) => s.id === currentId);
  const lastStep = currentIndex === STEPS.length - 1;
  return (
    <aside className="setup-rail" aria-label="Setup steps">
      <LogoLockup />
      <div className="intro">
        <div className="t-h3">Set up AsyncUp</div>
        <p className="t-small secondary">
          {lastStep ? 'Last step. Everything before this is done and verified.' : 'About 15 minutes. Progress is saved — you can leave and come back.'}
        </p>
      </div>
      <ol className="nav" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {STEPS.map((s, i) => {
          const done = progress ? stepDone(progress, s.id) : false;
          const cls = s.id === currentId ? 'step step-current' : done ? 'step step-done' : 'step';
          return (
            <li key={s.id} className={cls} aria-current={s.id === currentId ? 'step' : undefined}>
              <span className="step-num" aria-hidden="true">{done && s.id !== currentId ? '✓' : i + 1}</span>
              <Link to={s.path} className="grow" style={{ color: 'inherit' }}>
                <div className="t-medium">{s.title}</div>
                <div className="t-caption">{'optional' in s ? 'Optional' : done ? 'Done' : `~${s.minutes} min`}</div>
              </Link>
            </li>
          );
        })}
      </ol>
      <div className="spacer" />
      <div className="stuck card">
        <div className="t-strong">Stuck?</div>
        <p className="t-small secondary" style={{ margin: '4px 0 8px' }}>The full Google Chat guide has screenshots for every console screen.</p>
        <a className="t-small" href="https://asyncup-dev.github.io/docs/guide/google-chat-setup" target="_blank" rel="noreferrer">Open the guide ↗</a>
      </div>
    </aside>
  );
}

/** Rail + column layout shared by steps 1–5. */
export function StepPage({ id, title, lede, kicker, wide, children }: { id: string; title: string; lede: string; kicker?: string; wide?: boolean; children: ReactNode }) {
  const progress = useSetupProgress();
  const index = STEPS.findIndex((s) => s.id === id);
  return (
    <div className="setup">
      <StepRail progress={progress.data} currentId={id} />
      <main className="setup-main">
        <div className={`setup-col${wide ? ' setup-wide' : ''}`}>
          <div>
            <div className="t-label">{kicker ?? `Step ${index + 1} of ${STEPS.length}`}</div>
            <h1 className="t-h1" style={{ marginTop: 8 }}>{title}</h1>
            <p className="lede">{lede}</p>
          </div>
          {progress.isError ? <div className="alert">Could not load your setup state: {progress.error.message}</div> : null}
          {children}
        </div>
      </main>
    </div>
  );
}

export function StepActions({ back, children }: { back?: string; children: ReactNode }) {
  return (
    <div className="setup-actions">
      {back ? <Link to={back} className="btn btn-ghost">Back</Link> : null}
      <div className="grow" />
      {children}
    </div>
  );
}
