import { useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { usePatchSettings, useSettings } from '../../lib/settings';
import { fieldError, SettingsHeader } from './layout';

export function DangerSettings() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const [open, setOpen] = useState<'disconnect' | 'history' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const client = useQueryClient();
  const wipe = useMutation({
    mutationFn: () => api<{ deleted: { runs: number; submissions: number; blockers: number; polls: number } }>('/history', { method: 'DELETE', body: { confirm: 'DELETE HISTORY' } }),
    onSuccess: () => client.invalidateQueries(),
  });
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
          <button type="button" className="btn btn-danger" style={{ height: 28 }} disabled={!connected} onClick={() => setOpen('disconnect')}>Disconnect</button>
        </SettingsRow>
      </SectionCard>
      <SectionCard title="History">
        <SettingsRow label="Delete all standup history" hint="Removes every run, submission, blocker and poll in the workspace. Standups, people and settings stay. Exports already downloaded are unaffected. This cannot be undone.">
          <button type="button" className="btn btn-danger" style={{ height: 28 }} disabled={wipe.isPending} onClick={() => setOpen('history')}>Delete history</button>
        </SettingsRow>
      </SectionCard>
      {notice ? <div className="toast" role="status">{notice}</div> : null}
      {open === 'history' ? (
        <ConfirmDialog
          title="Delete all standup history?"
          body="Every run, submission, blocker and poll across every standup is removed permanently. Standups keep their people and settings and carry on from the next run."
          confirmLabel="Delete history"
          typed="DELETE HISTORY"
          danger
          onConfirm={async () => {
            try {
              setError(null);
              const { deleted } = await wipe.mutateAsync();
              setNotice(`Deleted ${deleted.runs} runs, ${deleted.submissions} submissions, ${deleted.blockers} blockers and ${deleted.polls} polls.`);
            } catch (err) {
              setError(fieldError(err));
            }
            setOpen(null);
          }}
          onCancel={() => setOpen(null)}
        />
      ) : null}
      {open === 'disconnect' ? (
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
              setOpen(null);
            } catch (err) {
              setError(fieldError(err));
              setOpen(null);
            }
          }}
          onCancel={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
