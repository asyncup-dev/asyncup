import { useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { usePatchSettings, useSettings } from '../../lib/settings';
import { fieldError, SettingsHeader } from './layout';

export function DangerSettings() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = settings.data;
  if (settings.isError) return <div className="alert">Could not load settings: {settings.error.message}</div>;
  if (!s) return <p className="muted">Loading…</p>;
  const connected = !!(s.chat.audience || s.chat.serviceAccount.set);
  return (
    <>
      <SettingsHeader title="Danger zone" lede="Actions that stop things. Each one asks you to type a word first." />
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <SectionCard title="Google Chat">
        <SettingsRow label="Disconnect Google Chat" hint="Standups stop immediately: the audience and the service-account key are removed. Standups, people and history are kept so you can reconnect through setup.">
          <span className={`badge ${connected ? 'badge-success' : ''}`}>{connected ? 'Connected' : 'Not connected'}</span>
          <button type="button" className="btn btn-danger" style={{ height: 28 }} disabled={!connected} onClick={() => setOpen(true)}>Disconnect</button>
        </SettingsRow>
      </SectionCard>
      <SectionCard title="History">
        <SettingsRow label="Delete all standup history" hint="Not available from the web app. Archive standups instead — history stays readable and exportable — or drop the database on the server.">
          <span className="badge">Not available</span>
        </SettingsRow>
      </SectionCard>
      {open ? (
        <ConfirmDialog
          title="Disconnect Google Chat?"
          body="Prompts, reminders and wrap-ups stop right away. Reconnect by running setup again."
          confirmLabel="Disconnect"
          typed="DISCONNECT"
          danger
          onConfirm={async () => {
            try {
              setError(null);
              await patch.mutateAsync({ chatAudience: '', serviceAccountJson: null, setupComplete: false });
              setOpen(false);
            } catch (err) {
              setError(fieldError(err));
              setOpen(false);
            }
          }}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
