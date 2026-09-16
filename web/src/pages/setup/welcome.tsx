import { Link } from '@tanstack/react-router';
import { LogoLockup, LogoMark } from '../../components/logo';
import { nextStep, STEPS, stepDone, useSetupProgress } from '../../lib/setup';

export function WelcomePage() {
  const progress = useSetupProgress();
  const p = progress.data;
  const start = p ? nextStep(p) : STEPS[0];
  const chatWorks = p ? stepDone(p, 'chat-app') : false;
  return (
    <div>
      <div className="setup-brandbar"><LogoLockup /></div>
      <div className="setup-centered">
        <LogoMark size={56} />
        <div>
          <h1 className="t-display" style={{ margin: 0 }}>Let’s get your first standup running</h1>
          <p className="lede t-body-lg" style={{ marginTop: 12 }}>
            Five steps, about fifteen minutes. Three of them happen in Google Cloud — we give you every value to paste and check each one live. Progress is saved as you go.
          </p>
        </div>
        {progress.isError ? <div className="alert">Could not load your setup state: {progress.error.message}</div> : null}
        <div className="card" style={{ display: 'grid' }}>
          {STEPS.map((s, i) => {
            const done = p ? stepDone(p, s.id) : false;
            return (
              <div key={s.id} className="plan-row">
                <span className="step-num" aria-hidden="true">{i + 1}</span>
                <div className="grow">
                  <div className="t-medium">{s.title}</div>
                  <div className="t-caption">{s.hint}</div>
                </div>
                <span className={`badge ${done ? 'badge-success' : ''}`}>{done ? 'Done' : 'optional' in s ? 'Optional' : 'To do'}</span>
                <span className="t-caption" style={{ width: 44, textAlign: 'right' }}>~{s.minutes} min</span>
              </div>
            );
          })}
        </div>
        <div className="row-wrap">
          <Link to={start.path} className="btn btn-primary btn-lg">{p && start.id !== 'project' ? 'Continue' : 'Start'}</Link>
          <Link to="/setup/project" className="btn btn-lg">Walk through every step</Link>
        </div>
        <p className="t-small muted" style={{ margin: 0 }}>
          {chatWorks ? 'Your Chat connection already works — Continue skips straight to step 5.' : 'Already have a working Chat connection? AsyncUp detects it and skips straight to step 5.'}
        </p>
      </div>
    </div>
  );
}
