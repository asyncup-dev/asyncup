import { useState } from 'react';
import { copyText } from '../lib/setup';

/** A labelled value with a Copy button — the "paste exactly this" rows of the Chat app step. */
export function CopyRow({ label, hint, value, mono = true }: { label: string; hint?: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <div className="copy-row-label">
        <div className="t-medium">{label}</div>
        {hint ? <div className="t-caption">{hint}</div> : null}
      </div>
      <div className={mono ? 't-mono copy-row-value' : 'copy-row-value'}>{value}</div>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={async () => {
          setCopied(await copyText(value));
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function StaticRow({ label, hint, value }: { label: string; hint?: string; value: string }) {
  return (
    <div className="copy-row">
      <div className="copy-row-label">
        <div className="t-medium">{label}</div>
        {hint ? <div className="t-caption">{hint}</div> : null}
      </div>
      <div className="copy-row-value secondary">{value}</div>
      <span />
    </div>
  );
}
