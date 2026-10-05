import { lazy, Suspense, useState } from 'react';
import { applyTheme, storedTheme, type Theme } from '../appearance';
import { Section } from '../management';
import { go } from '../app/route';
import { primaryWorkspace, refreshSoon, useGarden } from '../app/store';
import { ProviderSettings } from './Providers';
import { NotificationSettings } from './Notifications';
import { AccessSettings } from './Access';
import { ResultViewSettings } from './ResultViews';
import { SpendingSettings } from './Spending';
import './settings.css';

const ConnectionsLibrary = lazy(() =>
  import('../library/Connections').then((module) => ({ default: module.ConnectionsLibrary }))
);
const MemoryLibrary = lazy(() =>
  import('../library/Memory').then((module) => ({ default: module.MemoryLibrary }))
);
const SkillsLibrary = lazy(() =>
  import('../library/Skills').then((module) => ({ default: module.SkillsLibrary }))
);
const ComputerSettings = lazy(() =>
  import('./Computer').then((module) => ({ default: module.ComputerSettings }))
);
const InstanceSettings = lazy(() =>
  import('./Instance').then((module) => ({ default: module.InstanceSettings }))
);

const SECTIONS = [
  ['models', 'Models', 'Which models think, and who you pay for them'],
  ['connections', 'Connections', 'Mail, calendar, code and other services it may use'],
  ['knowledge', 'Knowledge', 'What it remembers about you, and the skills it has saved'],
  ['spending', 'Spending', 'Caps by goal, day and month, and what has been spent'],
  ['notifications', 'Notifications', 'What reaches your phone, and through what'],
  ['computer', 'Computer', 'The machine, its brief, its updates and its link'],
  ['appearance', 'Appearance', 'Day, night, and how results are shown'],
  ['account', 'Account', 'Passkeys, devices, sessions and your data']
] as const;
type SectionId = (typeof SECTIONS)[number][0];
/** Section names older links still carry. */
const ALIASES: Record<string, SectionId> = {
  instance: 'computer',
  autonomy: 'spending',
  access: 'account'
};

/** Settings: the things set once and left, each in its own room. */
export default function SettingsView({ section }: { section: string | null }) {
  const { bootstrap } = useGarden();
  const workspace = primaryWorkspace(bootstrap);
  const requested = (section ?? '').toLowerCase();
  const current: SectionId = SECTIONS.some(([id]) => id === requested)
    ? (requested as SectionId)
    : (ALIASES[requested] ?? 'models');
  const [theme, setTheme] = useState<Theme>(storedTheme);
  return (
    <div className="settings">
      <nav className="settings-nav scroll" aria-label="Settings">
        <h1 className="display">Settings</h1>
        {SECTIONS.map(([id, label, detail]) => (
          <button
            key={id}
            type="button"
            aria-current={current === id ? 'page' : undefined}
            onClick={() => go({ section: id }, { replace: true })}
          >
            <b>{label}</b>
            <span>{detail}</span>
          </button>
        ))}
      </nav>
      <div className="settings-room scroll management-page" key={current}>
        <Suspense fallback={<div className="skeleton" style={{ height: 200 }} />}>
          {current === 'models' && <ProviderSettings onChange={refreshSoon} />}
          {current === 'connections' && <ConnectionsLibrary onChange={refreshSoon} />}
          {current === 'knowledge' && (
            <>
              <MemoryLibrary
                workspace={workspace}
                projects={bootstrap?.projects ?? []}
                onOpenTask={(id) => go({ view: 'goal', goal: id })}
              />
              <SkillsLibrary workspace={workspace} />
            </>
          )}
          {current === 'spending' && <SpendingSettings onChange={refreshSoon} />}
          {current === 'notifications' && <NotificationSettings />}
          {current === 'computer' && workspace && (
            <>
              <ComputerSettings workspace={workspace} onChange={refreshSoon} />
              <InstanceSettings />
            </>
          )}
          {current === 'appearance' && (
            <>
              <Section title="Day or night" description="Applies at once, on this device.">
                <div className="seg" role="group" aria-label="Theme">
                  {(
                    [
                      ['system', 'Follow this device'],
                      ['light', 'Day'],
                      ['dark', 'Night']
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={theme === value}
                      onClick={() => {
                        applyTheme(value);
                        setTheme(value);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Section>
              <ResultViewSettings />
            </>
          )}
          {current === 'account' && <AccessSettings onChange={refreshSoon} />}
        </Suspense>
      </div>
    </div>
  );
}
