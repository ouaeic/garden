/**
 * Day or night. `system` follows the device; the other two are the owner's own choice and win over
 * it. Held per device, because a phone in bed and a desk at noon are different rooms.
 */
export type Theme = 'system' | 'light' | 'dark';
const KEY = 'garden-theme';

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export const isDark = (theme: Theme = storedTheme()) =>
  theme === 'dark' || (theme === 'system' && systemDark());

export function applyTheme(theme: Theme = storedTheme()): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // A private window keeps the choice for this visit only.
  }
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', isDark(theme) ? '#07120e' : '#e4ece3');
}

/** The header's switch: to whichever of day and night is not showing now. */
export const toggleTheme = () => applyTheme(isDark() ? 'light' : 'dark');
