import { lazy, Suspense, useEffect, useState } from 'react';
import { useSurfaceLocation } from './surface-location';
import { ConnectionsLibrary } from './library/Connections';
import type { Project, Workspace } from '@garden/contracts';
const ReviewLevelSettings = lazy(() =>
  import('./settings/Computer.js').then((module) => ({ default: module.ReviewLevelSettings }))
);
const MemoryLibrary = lazy(() =>
  import('./library/Memory.js').then((module) => ({ default: module.MemoryLibrary }))
);
const SkillsLibrary = lazy(() =>
  import('./library/Skills.js').then((module) => ({ default: module.SkillsLibrary }))
);
import { ProviderSettings } from './settings/Providers.js';
import { SpendingSettings } from './settings/Spending.js';
import { NotificationSettings } from './settings/Notifications.js';
import { AccessSettings } from './settings/Access.js';
import { ResultViewSettings } from './settings/ResultViews.js';
import { Section } from './management.js';
import { Field } from './ui.js';
import { palettes, type Palette } from './appearance';
import {
  lifeMode,
  onLifeModeChange,
  setLifeMode,
  setSound,
  soundOn,
  type LifeMode
} from './life/settings';
import { chirp } from './life/sound';
import './settings.css';

export interface SettingsProps {
  workspace: Workspace | null;
  onChange: () => void;
  theme: 'dark' | 'light';
  onThemeChange: (theme: 'dark' | 'light') => void;
  palette: Palette;
  onPaletteChange: (palette: Palette) => void;
  projects: Project[];
  onOpenTask: (id: string) => void;
}
const sections = [
  'Appearance',
  'Models',
  'Knowledge',
  'Connections',
  'Autonomy',
  'Notifications',
  'Account'
] as const;
// Section names that older links and deep links still carry.
const aliases: Record<string, (typeof sections)[number]> = {
  General: 'Appearance',
  Memory: 'Knowledge',
  Spending: 'Autonomy',
  Skills: 'Knowledge',
  'Account & devices': 'Account',
  Access: 'Account'
};
export function Settings({
  workspace,
  projects,
  onOpenTask,
  onChange,
  theme,
  onThemeChange,
  palette,
  onPaletteChange
}: SettingsProps) {
  const [life, setLife] = useState<LifeMode>(lifeMode);
  const [sound, setSoundState] = useState(soundOn);
  useEffect(() => onLifeModeChange(setLife), []);
  const [locationSection, setSection] = useSurfaceLocation('section', 'Appearance');
  const section = sections.includes(locationSection as (typeof sections)[number])
    ? locationSection
    : (aliases[locationSection] ?? 'Appearance');
  return (
    <div className="management-page">
      <header className="management-heading">
        <p className="eyebrow">Make it yours</p>
        <h1>Settings</h1>
        <p className="muted">Your models, your computer, your decisions.</p>
      </header>
      <nav className="management-tabs" aria-label="Settings sections">
        {sections.map((item) => (
          <button
            type="button"
            key={item}
            aria-current={section === item ? 'page' : undefined}
            onClick={() => setSection(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      <div className="management-content" key={section}>
        {section === 'Appearance' && (
          <Section title="Screen" description="Applies immediately on this device.">
            <div className="stack">
              <Field label="Theme">
                <select
                  value={theme}
                  onChange={(event) =>
                    onThemeChange(event.target.value === 'light' ? 'light' : 'dark')
                  }
                >
                  <option value="light">Light mode</option>
                  <option value="dark">Dark mode</option>
                </select>
              </Field>
              <fieldset className="palette-picker">
                <legend>Palette</legend>
                {palettes.map((item) => (
                  <label key={item.value} data-palette-swatch={item.value}>
                    <input
                      type="radio"
                      name="palette"
                      value={item.value}
                      checked={palette === item.value}
                      onChange={() => onPaletteChange(item.value)}
                    />
                    <span className="palette-swatch" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                    {item.label}
                  </label>
                ))}
              </fieldset>
              <Field
                label="Garden life"
                hint="Creatures that visit now and then. They never block a click and stay away while you type."
              >
                <select
                  value={life}
                  onChange={(event) => setLifeMode(event.target.value as LifeMode)}
                >
                  <option value="lively">Lively</option>
                  <option value="calm">Calm</option>
                  <option value="still">Still</option>
                </select>
              </Field>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={sound}
                  onChange={(event) => {
                    setSound(event.target.checked);
                    setSoundState(event.target.checked);
                    if (event.target.checked) chirp('bloom');
                  }}
                />
                Sound cues for finished work and requests
              </label>
            </div>
          </Section>
        )}
        {section === 'Appearance' && <ResultViewSettings />}
        {section === 'Models' && <ProviderSettings onChange={onChange} />}
        {section === 'Autonomy' && (
          <>
            <Suspense fallback={null}>
              <ReviewLevelSettings workspace={workspace} onChange={onChange} />
            </Suspense>
            <SpendingSettings onChange={onChange} />
          </>
        )}
        {section === 'Connections' && <ConnectionsLibrary onChange={onChange} />}
        {section === 'Knowledge' && (
          <Suspense fallback={null}>
            <MemoryLibrary workspace={workspace} projects={projects} onOpenTask={onOpenTask} />
            <SkillsLibrary workspace={workspace} />
          </Suspense>
        )}
        {section === 'Notifications' && <NotificationSettings />}
        {section === 'Account' && <AccessSettings onChange={onChange} />}
      </div>
    </div>
  );
}
export default Settings;
