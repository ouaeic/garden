export function storedDisplayMode(): 'light' | 'dark' {
  try {
    return localStorage.getItem('garden-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
