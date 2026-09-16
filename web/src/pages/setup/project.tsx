import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { fromMutation, VerifyStatus } from '../../components/verify-status';
import { projectNumberOf, useSaveSettings, useSetupProgress, useVerify } from '../../lib/setup';
import { StepActions, StepPage } from './layout';

const CHECKLIST = [
  ['Create a new project', 'Any name — “AsyncUp” is fine. Billing is not required.'],
  ['Enable the Google Chat API', 'APIs & Services → Library → “Google Chat API” → Enable'],
  ['Configure the OAuth consent screen', 'APIs & Services → OAuth consent screen → Internal. Needed before the Chat app can be configured.'],
  ['Copy the project number', 'Cloud overview → Project info. Digits only — not the project ID slug.'],
] as const;

export function ProjectPage() {
  const progress = useSetupProgress();
  const save = useSaveSettings();
  const verify = useVerify('project');
  const [number, setNumber] = useState('');
  const [ticks, setTicks] = useState<boolean[]>(CHECKLIST.map(() => false));
  const audience = progress.data?.settings.chat.audience ?? '';
  useEffect(() => {
    if (progress.data) setNumber(projectNumberOf(progress.data.settings.chat.audience));
  }, [progress.data]);

  const digits = number.trim();
  const valid = /^\d{6,}$/.test(digits);
  const saved = projectNumberOf(audience) === digits && digits !== '';
  const submit = async () => {
    // Keep any app-URL audience from step 3; swap only the number.
    const others = audience.split(/[\s,]+/).filter((a) => a && !/^\d+$/.test(a));
    await save.mutateAsync({ chatAudience: [digits, ...others].join(' ') });
    await verify.mutateAsync();
  };
  return (
    <StepPage id="project" title="Create a Google Cloud project" lede="AsyncUp talks to Google Chat through a Cloud project you own. Nothing runs there — it only holds the app registration and a service account.">
      <a className="btn" href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Open Google Cloud Console ↗</a>
      <div className="card checklist">
        {CHECKLIST.map(([title, hint], i) => (
          <label key={title}>
            <input type="checkbox" checked={ticks[i]} onChange={(e) => setTicks(ticks.map((t, j) => (j === i ? e.target.checked : t)))} />
            <span>
              <div className="t-medium">{title}</div>
              <div className="t-caption">{hint}</div>
            </span>
          </label>
        ))}
      </div>
      <div className="field" style={{ maxWidth: 404 }}>
        <label htmlFor="project-number">Project number</label>
        <div className="row">
          <input id="project-number" className="input" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="728449131907" />
          <button type="button" className="btn" disabled={!valid || save.isPending || verify.isPending} onClick={() => void submit()}>
            Verify
          </button>
        </div>
        {save.isError ? <div className="alert" role="alert">{save.error.message}</div> : null}
        <VerifyStatus state={fromMutation(verify)} idle={saved ? 'Saved. Verify to check the format.' : 'Not checked yet.'} />
      </div>
      <StepActions>
        <Link to="/setup/service-account" className="btn btn-primary" disabled={!saved} aria-disabled={!saved}>Continue</Link>
      </StepActions>
    </StepPage>
  );
}
