import { useState } from 'react';
import { Icons } from '../components/icons';
import { applyTheme, effectiveTheme } from '../lib/theme';

/** One click flips between light and dark; the stamp wins over the system setting from then on. */
export function ThemeToggle() {
  const [theme, setTheme] = useState(effectiveTheme);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      {theme === 'dark' ? <Icons.sun /> : <Icons.moon />}
    </button>
  );
}
