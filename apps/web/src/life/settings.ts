/**
 * Per-device preferences for the living layer. They are conveniences, so they live in local
 * storage, and every read survives storage being unavailable.
 */
export type LifeMode = 'lively' | 'calm' | 'still';
const MODE_KEY = 'garden-life';
const SOUND_KEY = 'garden-sound';
const EVENT = 'garden:life-settings';

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The choice still applies until the page reloads. */
  }
  dispatchEvent(new Event(EVENT));
}

export function lifeMode(): LifeMode {
  const value = read(MODE_KEY);
  return value === 'calm' || value === 'still' ? value : 'lively';
}
export const setLifeMode = (mode: LifeMode) => write(MODE_KEY, mode);
export const soundOn = () => read(SOUND_KEY) === 'on';
export const setSound = (on: boolean) => write(SOUND_KEY, on ? 'on' : 'off');

export function onLifeModeChange(listener: (mode: LifeMode) => void) {
  const handle = () => listener(lifeMode());
  addEventListener(EVENT, handle);
  addEventListener('storage', handle);
  return () => {
    removeEventListener(EVENT, handle);
    removeEventListener('storage', handle);
  };
}
