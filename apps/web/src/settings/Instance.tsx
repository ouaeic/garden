import { useEffect, useState } from 'react';
import { del, isNativeClient, patch, post } from '../client.js';
import ServerInstall from '../ServerInstall.js';
import { forgetNative, nativeBootstrap, setNetworkPreference } from '../native.js';
import type { NativeStatus, NetworkPreference } from '../native.js';
import { Button, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  fieldValue,
  sensitive,
  useAction,
  useResource
} from '../management.js';
import { data, text } from '../model.js';

interface Diagnostics {
  certificate: unknown;
  dynamicDns: unknown;
  backup: unknown;
  autoUpdate: unknown;
  backupTimer: unknown;
  build: { revision?: string; version?: string; dirty?: boolean };
}
interface Legal {
  applicationLicense: string;
  sourceUrl: string | null;
  privacyUrl: string | null;
}
export function InstanceSettings() {
  const diagnostics = useResource<Diagnostics>('/v1/instance/diagnostics');
  const relay = useResource<Record<string, unknown>>('/v1/relay');
  const legal = useResource<Legal>('/v1/legal');
  const native = useResource<NativeStatus>(isNativeClient() ? '/__garden/client/status' : null);
  const [installerUrl, setInstallerUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isNativeClient()) return;
    const controller = new AbortController();
    void nativeBootstrap(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setInstallerUrl(result.installerUrl);
      })
      .catch(() => {
        /* The terminal installer remains available if the native gateway is offline. */
      });
    return () => controller.abort();
  }, []);
  const action = useAction(() => {
    diagnostics.refresh();
    relay.refresh();
    native.refresh();
  });
  return (
    <>
      {isNativeClient() && (
        <Section title="This app’s connection">
          <ResourceState resource={native} />
          {native.value && (
            <>
              <p>
                {native.value.connected
                  ? 'Connected to your server'
                  : 'Your server is out of reach'}
              </p>
              {native.value.endpoints.map((endpoint) => (
                <p className="muted" key={endpoint}>
                  {endpoint}
                </p>
              ))}
              {native.value.identity && (
                <details>
                  <summary>Server identity</summary>
                  <pre>{native.value.identity}</pre>
                </details>
              )}
              <Field label="Server connection">
                <select
                  value={native.value.networkPreference ?? 'unknown'}
                  disabled={action.busy}
                  onChange={(event) => {
                    const preference = event.target.value as NetworkPreference;
                    void action.run(
                      () => setNetworkPreference(preference),
                      'Connection preference saved'
                    );
                  }}
                >
                  <option value="unknown">Choose automatically</option>
                  <option value="dynamic">Home or changing address</option>
                  <option value="fixed">Fixed server address</option>
                </select>
              </Field>
              <ConfirmButton
                label="Disconnect this app"
                description="Forget the saved server connection on this device. Your server and work remain available; a new connection ticket reconnects this app."
                action={async () => {
                  await forgetNative();
                  location.reload();
                }}
              />
              <ActionFeedback action={action} />
            </>
          )}
        </Section>
      )}
      <Section title="Your server" description="Live maintenance information from this computer.">
        <ResourceState resource={diagnostics} />
        {diagnostics.value && (
          <>
            <p className="management-metadata muted">
              Build{' '}
              {diagnostics.value.build.revision ||
                diagnostics.value.build.version ||
                'identity unavailable'}
              {diagnostics.value.build.dirty ? ' · local changes' : ''}
            </p>
            <div className="management-list">
              {(['certificate', 'dynamicDns', 'backup', 'autoUpdate', 'backupTimer'] as const).map(
                (key) => (
                  <div className="management-item" key={key}>
                    <div>
                      <strong>
                        {
                          {
                            certificate: 'Certificate',
                            dynamicDns: 'Dynamic DNS',
                            backup: 'Latest backup',
                            autoUpdate: 'Automatic updates',
                            backupTimer: 'Backup schedule'
                          }[key]
                        }
                      </strong>
                      {diagnostics.value![key] === null ? (
                        <p className="muted">No failure recorded.</p>
                      ) : (
                        <pre>
                          {typeof diagnostics.value![key] === 'string'
                            ? String(diagnostics.value![key])
                            : JSON.stringify(diagnostics.value![key], null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          </>
        )}
        <Button
          disabled={action.busy}
          onClick={() => {
            diagnostics.refresh();
            relay.refresh();
          }}
        >
          Refresh status
        </Button>
      </Section>
      <Section
        title="Relay connection"
        description="Optional access to your own computer through an enrolled relay."
      >
        <ResourceState resource={relay} />
        {relay.value && (
          <>
            <p>
              {text(
                data(relay.value.status).state,
                text(relay.value.state, relay.value.enabled ? 'Enabled' : 'Disabled')
              )}
            </p>
            {text(relay.value.hostname) && <p className="muted">{text(relay.value.hostname)}</p>}
            {text(data(relay.value.status).lastError) && (
              <p role="status">{text(data(relay.value.status).lastError)}</p>
            )}
            <details>
              <summary>Connection details</summary>
              <pre>{JSON.stringify(relay.value, null, 2)}</pre>
            </details>
            <div className="row">
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () =>
                      sensitive(() =>
                        patch('/v1/relay', {
                          enabled: !(relay.value!.enabled ?? data(relay.value!.settings).enabled)
                        })
                      ),
                    'Relay setting updated'
                  )
                }
              >
                {(relay.value.enabled ?? data(relay.value.settings).enabled)
                  ? 'Turn off relay'
                  : 'Turn on relay'}
              </Button>
              <ConfirmButton
                label="Forget relay"
                description="Remove this relay enrollment. You may lose remote access through its address; direct access to your server remains available."
                action={async () => {
                  await sensitive(() => del('/v1/relay'));
                  relay.refresh();
                }}
              />
            </div>
          </>
        )}
        <details>
          <summary>Enroll with a relay</summary>
          <form
            className="stack management-filter"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const values = new FormData(form);
              void action.run(async () => {
                await sensitive(() =>
                  post('/v1/relay/enrollment', {
                    host: fieldValue(values, 'host'),
                    token: fieldValue(values, 'token'),
                    ...(fieldValue(values, 'address')
                      ? { address: fieldValue(values, 'address') }
                      : {}),
                    ...(fieldValue(values, 'port') ? { port: Number(values.get('port')) } : {})
                  })
                );
                form.reset();
              }, 'Relay enrolled');
            }}
          >
            <div className="management-grid">
              <Field label="Relay hostname">
                <input required name="host" placeholder="relay.example.com" />
              </Field>
              <Field label="Enrollment token">
                <input required type="password" name="token" autoComplete="new-password" />
              </Field>
              <Field label="Address override · optional">
                <input name="address" />
              </Field>
              <Field label="Port override · optional">
                <input name="port" type="number" min="1" max="65535" />
              </Field>
            </div>
            <Button type="submit" busy={action.busy}>
              Enroll relay
            </Button>
          </form>
        </details>
        <ActionFeedback action={action} />
      </Section>
      <Section
        title="Maintenance"
        description="Installation and updates run on the server you own."
      >
        <p className="muted">
          For a health report, run this in your server administration terminal:
        </p>
        <pre>sudo garden doctor</pre>
        <p className="muted">To update the application with its built-in backup and rollback:</p>
        <pre>sudo garden update</pre>
        <details>
          <summary>Automatic updates and backups</summary>
          <pre>
            {
              'sudo garden auto-update status\nsudo garden auto-update on\nsudo garden auto-update off'
            }
          </pre>
          <p className="muted">
            The status above reports the configured timers. An update may wait for active tasks or
            background processes to finish.
          </p>
        </details>
        <p className="management-note">
          Server installation, updates and full backup restoration are administered on the host. The
          browser provides status and workspace recovery points.
        </p>
      </Section>
      <Section title="About garden">
        <ResourceState resource={legal} />
        <p>A free, self-hosted agent computer for one owner.</p>
        {legal.value && (
          <div className="row">
            <span>{legal.value.applicationLicense}</span>
            {legal.value.sourceUrl && (
              <a className="button" href={legal.value.sourceUrl} target="_blank" rel="noreferrer">
                Source code
              </a>
            )}
            {legal.value.privacyUrl && (
              <a className="button" href={legal.value.privacyUrl} target="_blank" rel="noreferrer">
                Privacy information
              </a>
            )}
          </div>
        )}
      </Section>
      <Section title="Install a server">
        <ServerInstall installerUrl={installerUrl} />
      </Section>
    </>
  );
}
