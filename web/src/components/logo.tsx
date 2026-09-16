/** Ink tile with ascending amber bars — the v2 mark. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="10" fill="var(--brand-ink-deep)" />
      <rect x="11" y="28" width="6" height="10" rx="1.5" fill="var(--accent-primary)" />
      <rect x="21" y="20" width="6" height="18" rx="1.5" fill="var(--accent-primary)" />
      <rect x="31" y="11" width="6" height="27" rx="1.5" fill="var(--accent-primary)" />
    </svg>
  );
}

export function LogoLockup() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <LogoMark size={28} />
      <span className="t-h3">AsyncUp</span>
    </span>
  );
}
