import { useEffect, useState } from 'react';
import { useSurfaceLocation } from './surface-location';
import { ConnectionsLibrary } from './library/Connections';
import type { Workspace } from '@garden/contracts';
import { ProviderSettings } from './settings/Providers.js';
import { SpendingSettings } from './settings/Spending.js';
import { ComputerSettings } from './settings/Computer.js';
import { NotificationSettings } from './settings/Notifications.js';
import { AccessSettings } from './settings/Access.js';
import { InstanceSettings } from './settings/Instance.js';
import { Section } from './management.js';
import { Button, Field } from './ui.js';
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
  onComputer: () => void;
}
const sections = [
  'Appearance',
  'Models',
  'Connections',
  'Spending',
  'Notifications',
  'Account',
  'Computer'
] as const;
// Section names that older links and deep links still carry.
const aliases: Record<string, (typeof sections)[number]> = {
  General: 'Appearance',
  'Computer & maintenance': 'Computer',
  Instance: 'Computer',
  'Account & devices': 'Account',
  Access: 'Account'
};
export function Settings({
  workspace,
  onComputer,
  onChange,
  theme,
  onThemeChange,
  palette,
  onPaletteChange
}: SettingsProps) {
  const [maintenanceOpened, setMaintenanceOpened] = useState(false);
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
              <Field label="Mode">
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
        {section === 'Models' && <ProviderSettings onChange={onChange} />}
        {section === 'Spending' && <SpendingSettings onChange={onChange} />}
        {section === 'Connections' && <ConnectionsLibrary onChange={onChange} />}
        {section === 'Computer' && (
          <>
            <Section
              title="Your computer"
              description="Project tools are available inside each project. Manage the whole computer here."
            >
              <Button onClick={onComputer}>All computer work</Button>
            </Section>
            <ComputerSettings workspace={workspace} onChange={onChange} />
            <details
              className="settings-disclosure"
              onToggle={(event) => {
                if (event.currentTarget.open) setMaintenanceOpened(true);
              }}
            >
              <summary>Installation and maintenance</summary>
              {maintenanceOpened && <InstanceSettings />}
            </details>
          </>
        )}
        {section === 'Notifications' && <NotificationSettings />}
        {section === 'Account' && <AccessSettings onChange={onChange} />}
      </div>
    </div>
  );
}
export default Settings;
