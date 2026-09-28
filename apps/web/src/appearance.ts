export function storedDisplayMode(): 'light' | 'dark' {
  try {
    return localStorage.getItem('garden-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
