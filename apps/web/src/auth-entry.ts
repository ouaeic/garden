import { useEffect, useState } from 'react';

/** Setup links can arrive in an already-open tab without reloading the application. */
export function useAuthEntry() {
  const [fragment, setFragment] = useState(() => location.hash);
  useEffect(() => {
    const changed = (event: HashChangeEvent) => setFragment(new URL(event.newURL).hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return [fragment, setFragment] as const;
}
