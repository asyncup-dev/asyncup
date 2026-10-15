import { useState } from 'react';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { timezoneOptions } from '../../lib/setup';
import { usePatchSettings, useSettings } from '../../lib/settings';
import { fieldError, SettingsHeader } from './layout';

export function GeneralSettings() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const [tz, setTz] = useState<string | null>(null);
  const [words, setWords] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = settings.data;
  if (settings.isError) return <div className="alert">Could not load settings: {settings.error.message}</div>;
  if (!s) return <p className="muted">Loading…</p>;
  const save = async (body: Record<string, unknown>) => {
    try {
      setError(null);
      await patch.mutateAsync(body);
    } catch (err) {
      setError(fieldError(err));
    }
  };
  const zone = tz ?? s.workspace.defaultTimezone;
  return (
    <>
      <SettingsHeader title="General" lede="Workspace defaults. Each row saves on its own." />
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <SectionCard title="Defaults">
        <SettingsRow label="Default timezone for new standups" hint="Participants can override with their own.">
          <select className="input" aria-label="Default timezone" value={zone} onChange={(e) => setTz(e.target.value)}>
            {timezoneOptions(s.workspace.defaultTimezone).map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
          <button type="button" className="btn" style={{ height: 28 }} disabled={zone === s.workspace.defaultTimezone || patch.isPending} onClick={() => void save({ defaultTimezone: zone })}>Save</button>
        </SettingsRow>
        <SettingsRow label="Calendar out-of-office" hint="Auto-mark people away on OOO days. Needs domain-wide delegation of https://www.googleapis.com/auth/calendar.events.readonly to the client ID under Google Chat.">
          <label className="row t-small">
            <input type="checkbox" aria-label="Calendar out-of-office" checked={s.workspace.calendarOoo} onChange={(e) => void save({ calendarOoo: e.target.checked })} /> {s.workspace.calendarOoo ? 'On' : 'Off'}
          </label>
        </SettingsRow>
      </SectionCard>
      <SectionCard title="Leave in Chat and Calendar" hint="Days off and vacation mode show as people’s Chat status and a Calendar out-of-office event.">
        <SettingsRow label="Show leave in Chat and Calendar" hint="Needs domain-wide delegation of https://www.googleapis.com/auth/chat.users.availability and https://www.googleapis.com/auth/calendar.events to the client ID under Google Chat.">
          <label className="row t-small">
            <input type="checkbox" aria-label="Show leave in Chat and Calendar" checked={s.workspace.leaveInChat} onChange={(e) => void save({ leaveInChat: e.target.checked })} /> {s.workspace.leaveInChat ? 'On' : 'Off'}
          </label>
        </SettingsRow>
        <SettingsRow label="Decline invites during leave" hint="What the out-of-office event does with meeting invites that clash.">
          <select className="input" aria-label="Decline invites during leave" value={s.workspace.leaveDeclineMode} onChange={(e) => void save({ leaveDeclineMode: e.target.value })}>
            <option value="none">Decline nothing</option>
            <option value="new">Decline new invites</option>
            <option value="all">Decline all clashes</option>
          </select>
        </SettingsRow>
        {s.workspace.leaveSyncError ? (
          <SettingsRow label="Latest problem" hint="Retried an hour later.">
            <div className="alert">
              {s.workspace.leaveSyncError.message}{' '}
              {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: s.workspace.defaultTimezone }).format(new Date(s.workspace.leaveSyncError.at))}
            </div>
          </SettingsRow>
        ) : null}
      </SectionCard>
      <SectionCard title="Spelling suggestions" hint="Likely typos in Chat answers are pointed out once before posting. Nothing leaves the server.">
        <SettingsRow label="Suggest spelling fixes" hint="Uses about 350 MB while people are answering, freed after 30 minutes without an answer.">
          <label className="row t-small">
            <input type="checkbox" aria-label="Suggest spelling fixes" checked={s.workspace.spelling.enabled} onChange={(e) => void save({ spellingEnabled: e.target.checked })} /> {s.workspace.spelling.enabled ? 'On' : 'Off'}
          </label>
        </SettingsRow>
        <SettingsRow label="Spelling" hint="Which English the checker expects. The web app’s own spell check follows it too.">
          <select className="input" aria-label="Spelling" value={s.workspace.spelling.dialect} onChange={(e) => void save({ spellingDialect: e.target.value })}>
            <option value="en-GB">British English</option>
            <option value="en-US">American English</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Words to accept" hint="One per line. Names on any roster are accepted too.">
          <textarea className="input" aria-label="Words to accept" rows={4} spellCheck={false} value={words ?? s.workspace.spelling.words.join('\n')} onChange={(e) => setWords(e.target.value)} />
          <button type="button" className="btn" style={{ height: 28 }} disabled={words === null || patch.isPending} onClick={() => void save({ spellingWords: words ?? '' }).then(() => setWords(null))}>Save</button>
        </SettingsRow>
      </SectionCard>
    </>
  );
}
