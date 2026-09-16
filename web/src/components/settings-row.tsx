import type { ReactNode } from 'react';

/** One labelled row in a settings card: label + hint on the left, the control on the right. */
export function SettingsRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div>
        <div className="t-medium">{label}</div>
        {hint ? <div className="t-caption">{hint}</div> : null}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

export function SectionCard({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div className="grow">
          <h2 className="t-h3" style={{ margin: 0 }}>{title}</h2>
          {hint ? <div className="t-caption">{hint}</div> : null}
        </div>
        {action}
      </div>
      <div className="settings-rows">{children}</div>
    </section>
  );
}
