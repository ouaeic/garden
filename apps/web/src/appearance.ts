export function storedDisplayMode(): 'light' | 'dark' {
  try {
    return localStorage.getItem('garden-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Each screen uses the same four-shade LCD ramp. */
export type Palette = 'field' | 'pocket' | 'backlight' | 'amber';
export const palettes: { value: Palette; label: string }[] = [
  { value: 'field', label: 'Field green' },
  { value: 'pocket', label: 'Pocket grey' },
  { value: 'backlight', label: 'Backlight teal' },
  { value: 'amber', label: 'Warm amber (low blue light)' }
];
export function storedPalette(): Palette {
  try {
    const value = localStorage.getItem('garden-palette');
    return value === 'pocket' || value === 'backlight' || value === 'amber' ? value : 'field';
  } catch {
    return 'field';
  }
}
