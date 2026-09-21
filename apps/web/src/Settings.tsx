import { useState } from 'react';
import type { Workspace } from '@athanor/contracts';
import { ProviderSettings } from './settings/Providers.js';
import { SpendingSettings } from './settings/Spending.js';
import { ComputerSettings } from './settings/Computer.js';
import { NotificationSettings } from './settings/Notifications.js';
import { AccessSettings } from './settings/Access.js';
import { InstanceSettings } from './settings/Instance.js';
import { Section } from './management.js';
import { Field } from './ui.js';
import './settings.css';

export interface SettingsProps {
  workspace: Workspace | null;
  onChange: () => void;
  theme: 'dark' | 'light';
  onThemeChange: (theme: 'dark' | 'light') => void;
  motionPaused: boolean;
  onMotionPausedChange: (paused: boolean) => void;
}
const sections = [
  'General',
  'Models',
  'Spending',
  'Computer',
  'Notifications',
  'Access',
  'Instance'
] as const;
export function Settings({
  workspace,
  onChange,
  theme,
  onThemeChange,
  motionPaused,
  onMotionPausedChange
}: SettingsProps) {
  const [section, setSection] = useState<(typeof sections)[number]>('General');
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
        {section === 'Computer' && <ComputerSettings workspace={workspace} onChange={onChange} />}
        {section === 'Notifications' && <NotificationSettings />}
        {section === 'Access' && <AccessSettings onChange={onChange} />}
        {section === 'Instance' && <InstanceSettings />}
      </div>
    </div>
  );
}
export default Settings;
