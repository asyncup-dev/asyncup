import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { CopyRow } from '../../components/copy-row';
import { fromMutation, VerifyStatus } from '../../components/verify-status';
import { useSaveSettings, useSetupProgress, useVerify } from '../../lib/setup';
import { StepActions, StepPage } from './layout';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

function parseKey(text: string): { ok: true; email: string; clientId: string | null } | { ok: false; message: string } {
  try {
    const k = JSON.parse(text);
    if (!k.client_email || !k.private_key) return { ok: false, message: 'That JSON is missing client_email / private_key — paste the full service-account key file.' };
    return { ok: true, email: String(k.client_email), clientId: k.client_id ? String(k.client_id) : null };
  } catch {
    return { ok: false, message: 'The service-account key must be valid JSON — paste the whole downloaded file.' };
  }
}

export function ServiceAccountPage() {
  const progress = useSetupProgress();
  const save = useSaveSettings();
  const verify = useVerify('service-account');
  const [text, setText] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [ooo, setOoo] = useState<boolean | null>(null);

  const sa = progress.data?.settings.chat.serviceAccount;
  const stored = sa?.set ?? false;
  const oooOn = ooo ?? !!progress.data?.settings.workspace.calendarOoo;

  const submitKey = async () => {
    const parsed = parseKey(text);
    if (!parsed.ok) {
      setLocalError(parsed.message);
      return;
    }
    setLocalError(null);
    await save.mutateAsync({ serviceAccountJson: text });
    setText('');
    await verify.mutateAsync();
  };
  const saveOoo = async () => {
    await save.mutateAsync({ calendarOoo: oooOn });
  };

  return (
    <StepPage id="service-account" title="Service account" lede="This is the identity AsyncUp uses to send messages. Create it in your project, download the JSON key, and paste the whole file below. The key is encrypted at rest and never leaves your server.">
      <a className="btn" href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noreferrer">Open IAM → Service accounts ↗</a>
      <div className="card section">
        <label htmlFor="sa-key" className="t-medium">Service-account key (JSON)</label>
        <textarea
          id="sa-key"
          className="paste"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={stored ? `A key for ${sa?.email ?? 'the service account'} is stored. Paste a new one to replace it.` : '{ "type": "service_account", "project_id": "…", "client_email": "…", "private_key": "-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----" }'}
          spellCheck={false}
        />
        {localError || save.isError ? <div className="alert" role="alert">{localError ?? save.error?.message}</div> : null}
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={!text.trim() || save.isPending || verify.isPending} onClick={() => void submitKey()}>
            Save and verify key
          </button>
          {stored ? (
            <button type="button" className="btn btn-ghost" disabled={verify.isPending} onClick={() => verify.mutate()}>
              Verify stored key
            </button>
          ) : null}
          {text ? <button type="button" className="btn btn-ghost" onClick={() => setText('')}>Clear</button> : null}
        </div>
      </div>
      <VerifyStatus state={fromMutation(verify)} idle={stored ? `A key for ${sa?.email ?? 'the service account'} is stored.` : 'Not checked yet.'} />
      <div className="card section">
        <div className="switch">
          <input id="ooo" type="checkbox" checked={oooOn} onChange={(e) => setOoo(e.target.checked)} />
          <label htmlFor="ooo">
            <div className="t-medium">Calendar out-of-office (optional)</div>
            <div className="t-caption">Marks people away on days with an Out of office event in Google Calendar. Needs domain-wide delegation for the scope below. Group rosters and user lookups don't: they use an admin role on the service account (see the Directory guide).</div>
          </label>
        </div>
        {oooOn ? (
          <div className="card">
            <CopyRow label="Client ID for delegation" hint="Admin console → Security → API controls → Domain-wide delegation" value={sa?.clientId ?? 'Paste and save the key first'} />
            <CopyRow label="OAuth scope" hint="Add it on the same row as the client ID" value={CALENDAR_SCOPE} />
          </div>
        ) : null}
        <div className="row">
          <button type="button" className="btn" disabled={save.isPending} onClick={() => void saveOoo()}>
            Save
          </button>
        </div>
      </div>
      <StepActions back="/setup/project">
        <Link to="/setup/chat-app" className="btn btn-primary" disabled={!stored} aria-disabled={!stored}>Continue</Link>
      </StepActions>
    </StepPage>
  );
}
