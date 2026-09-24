import { useState } from 'react';
import { useSurfaceLocation } from './surface-location';
import { ConnectionsLibrary } from './library/Connections';
import type { Workspace } from '@athanor/contracts';
import { ProviderSettings } from './settings/Providers.js';
import { SpendingSettings } from './settings/Spending.js';
import { ComputerSettings } from './settings/Computer.js';
import { NotificationSettings } from './settings/Notifications.js';
import { AccessSettings } from './settings/Access.js';
import { InstanceSettings } from './settings/Instance.js';
import { Section } from './management.js';
import { Button, Field } from './ui.js';
import './settings.css';

export interface SettingsProps {
  workspace: Workspace | null;
  onChange: () => void;
  theme: 'dark' | 'light';
  onThemeChange: (theme: 'dark' | 'light') => void;
  onComputer: () => void;
  motionPaused: boolean;
  onMotionPausedChange: (paused: boolean) => void;
}
const sections = [
  'General',
  'Models',
  'Connections',
  'Spending',
  'Notifications',
  'Account & devices',
  'Computer & maintenance'
] as const;
export function Settings({
  workspace,
  onComputer,
  onChange,
  theme,
  onThemeChange,
  motionPaused,
  onMotionPausedChange
}: SettingsProps) {
  const [maintenanceOpened, setMaintenanceOpened] = useState(false);
  const [locationSection, setSection] = useSurfaceLocation('section', 'General');
  const section = sections.includes(locationSection as (typeof sections)[number])
    ? locationSection
    : locationSection === 'Computer' || locationSection === 'Instance'
      ? 'Computer & maintenance'
      : locationSection === 'Access'
        ? 'Account & devices'
        : 'General';
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
        {section === 'General' && (
          <Section title="Appearance" description="Applies immediately on this device.">
            <div className="stack">
              <Field label="Theme">
                <select
                  value={theme}
                  onChange={(event) =>
                    onThemeChange(event.target.value === 'light' ? 'light' : 'dark')
                  }
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </Field>
              <label className="management-check">
                <input
                  type="checkbox"
                  checked={!motionPaused}
                  onChange={(event) => onMotionPausedChange(!event.target.checked)}
                  aria-label="Background motion"
                  aria-describedby="background-motion-hint"
                />
                <span>
                  Background motion
                  <small id="background-motion-hint" className="muted">
                    Gentle movement in the green panels. Respects your device’s reduced-motion
                    setting.
                  </small>
                </span>
              </label>
            </div>
          </Section>
        )}
        {section === 'Models' && <ProviderSettings onChange={onChange} />}
        {section === 'Spending' && <SpendingSettings onChange={onChange} />}
        {section === 'Connections' && <ConnectionsLibrary onChange={onChange} />}
        {section === 'Computer & maintenance' && (
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
        {section === 'Account & devices' && <AccessSettings onChange={onChange} />}
      </div>
    </div>
  );
}
export default Settings;
