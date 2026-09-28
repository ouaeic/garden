export function storedDisplayMode(): 'light' | 'dark' {
  try {
    return localStorage.getItem('garden-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Three screens from the same family: the original green, the grey pocket, the backlit teal. */
export type Palette = 'field' | 'pocket' | 'backlight';
export const palettes: { value: Palette; label: string }[] = [
  { value: 'field', label: 'Field green' },
  { value: 'pocket', label: 'Pocket grey' },
  { value: 'backlight', label: 'Backlight teal' }
];
export function storedPalette(): Palette {
  try {
    const value = localStorage.getItem('garden-palette');
    return value === 'pocket' || value === 'backlight' ? value : 'field';
  } catch {
    return 'field';
  }
}
