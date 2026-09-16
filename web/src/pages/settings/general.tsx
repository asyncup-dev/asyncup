import { useState } from 'react';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { timezoneOptions } from '../../lib/setup';
import { usePatchSettings, useSettings } from '../../lib/settings';
import { fieldError, SettingsHeader } from './layout';

export function GeneralSettings() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const [tz, setTz] = useState<string | null>(null);
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
        <SettingsRow label="Calendar out-of-office" hint="Auto-mark people away on OOO days. Needs Directory & Calendar access under Google Chat.">
          <label className="row t-small">
            <input type="checkbox" checked={s.workspace.calendarOoo} onChange={(e) => void save({ calendarOoo: e.target.checked })} /> {s.workspace.calendarOoo ? 'On' : 'Off'}
          </label>
        </SettingsRow>
      </SectionCard>
    </>
  );
}
