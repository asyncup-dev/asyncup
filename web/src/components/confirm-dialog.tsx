import { useState } from 'react';

export interface ConfirmProps {
  title: string;
  body: string;
  confirmLabel: string;
  /** When set, the user must type this word before the confirm button enables. */
  typed?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel, typed, danger, onConfirm, onCancel }: ConfirmProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = !typed || text.trim() === typed;
  return (
    <div className="scrim" role="presentation" onClick={onCancel}>
      <div className="dialog card" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title" className="t-h3" style={{ margin: 0 }}>{title}</h2>
        <p className="t-small secondary" style={{ margin: 0 }}>{body}</p>
        {typed ? (
          <div className="field">
            <label htmlFor="confirm-typed">Type <strong>{typed}</strong> to confirm</label>
            <input id="confirm-typed" className="input" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          </div>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={!ready || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
