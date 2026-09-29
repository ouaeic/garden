import { DeviceDraftSettings } from './DeviceDrafts.js';
import { useState } from 'react';
import type { ApiToken, ApiTokenScope } from '@garden/contracts';
import { del, post } from '../client.js';
import { addPasskey } from '../auth.js';
import { revokeDeviceSession, signOutThisDevice } from './session-actions.js';
import { Button, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  SecretResult,
  download,
  fieldValue,
  sensitive,
  useAction,
  useResource
} from '../management.js';
import { date } from '../model.js';

interface Session {
  id: string;
  deviceLabel?: string;
  current?: boolean;
  createdAt: string;
  expiresAt?: string;
  lastSeenAt?: string;
}
interface Passkey {
  id: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: string;
}
interface Enrollment {
  id: string;
  label: string;
  expiresAt: string;
  createdAt?: string;
}
interface EnrollmentLink {
  id: string;
  expiresAt: string;
  uri: string;
  webUri: string;
}
const scopes: ApiTokenScope[] = [
  'workspaces:read',
  'workspaces:write',
  'tasks:read',
  'tasks:write',
  'files:read',
  'files:write',
  'approvals:read',
  'approvals:write',
  'models:read',
  'usage:read',
  'connectors:read'
];

export function AccessSettings({ onChange }: { onChange: () => void }) {
  const account = useResource<{ user: { username: string; displayName: string } }>('/v1/auth/me');
  const sessions = useResource<Session[]>('/v1/sessions');
  const passkeys = useResource<Passkey[]>('/v1/auth/passkeys');
  const enrollments = useResource<Enrollment[]>('/v1/devices/enrollments');
  const tokens = useResource<ApiToken[]>('/v1/api-tokens');
  const [enrollment, setEnrollment] = useState<EnrollmentLink | null>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [password, setPassword] = useState('');
  const [qr, setQr] = useState('');
  const action = useAction(() => {
    sessions.refresh();
    passkeys.refresh();
    enrollments.refresh();
    tokens.refresh();
  });
  return (
    <>
      <Section title="Your account">
        <ResourceState resource={account} />
        {account.value && (
          <>
            <h4>{account.value.user.displayName}</h4>
            <p className="muted">{account.value.user.username}</p>
            <div className="row">
              <ConfirmButton
                label="Sign out this device"
                description="End this device session and remove its unsynced drafts. Synced drafts remain on your server."
                action={signOutThisDevice}
              />
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () => download('/v1/privacy/export', 'garden-account.json', true),
                    'Account export downloaded'
                  )
                }
              >
                Download my data
              </Button>
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const result = await sensitive(() =>
                      post<{ recoveryCode: string }>('/v1/auth/recovery-code')
                    );
                    setSecret({
                      label: 'New recovery code · save it somewhere safe',
                      value: result.recoveryCode
                    });
                  }, 'Recovery code replaced')
                }
              >
                Replace recovery code
              </Button>
            </div>
          </>
        )}
        {secret && (
          <>
            <SecretResult label={secret.label} value={secret.value} />
            <Button onClick={() => setSecret(null)}>I have saved it</Button>
          </>
        )}
        <ActionFeedback action={action} />
      </Section>
      <Section
        title="Password"
        description="Sign in on any device with your Garden password. Devices stay signed in until you sign them out."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              await sensitive(() => post('/v1/auth/password', { password }));
              setPassword('');
            }, 'Password saved. Other devices have been signed out.');
          }}
        >
          <Field label="New password">
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              maxLength={1024}
            />
          </Field>
          <p className="muted">Use at least 15 characters. A few words work well.</p>
          <Button type="submit" busy={action.busy}>
            Save password
          </Button>
        </form>
        <ActionFeedback action={action} />
      </Section>
      <Section
        title="Passkeys"
        description="An optional way to sign in without typing your password."
      >
        <ResourceState resource={passkeys} />
        <div className="management-list">
          {passkeys.value?.map((key) => (
            <div className="management-item" key={key.id}>
              <div>
                <strong>{key.backedUp ? 'Synced passkey' : 'Device passkey'}</strong>
                <p className="muted">
                  {key.deviceType} · {date(key.createdAt)}
                </p>
                {key.transports.length > 0 && (
                  <p className="management-metadata muted">{key.transports.join(', ')}</p>
                )}
              </div>
              <ConfirmButton
                label="Remove passkey"
                description="This passkey will no longer sign in. Keep a working password or another passkey before removing it."
                action={async () => {
                  await sensitive(() => del(`/v1/auth/passkeys/${key.id}`));
                  passkeys.refresh();
                }}
              />
            </div>
          ))}
        </div>
        {passkeys.value?.length === 0 && (
          <p className="muted">No passkeys added. You can use your password.</p>
        )}
        <Button busy={action.busy} onClick={() => void action.run(addPasskey, 'Passkey added')}>
          Add a passkey
        </Button>
        <ActionFeedback action={action} />
      </Section>
      <Section
        title="Connect another device"
        description="Open your Garden address on the new device and sign in with your password, or create an invitation to add a passkey."
      >
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void action.run(async () => {
              const result = await sensitive(() =>
                post<EnrollmentLink>('/v1/devices/enrollments', {
                  label: fieldValue(form, 'label') || 'New device'
                })
              );
              setEnrollment(result);
              setQr('');
              try {
                const encoder = await import('qrcode');
                setQr(
                  await encoder.toDataURL(result.webUri, {
                    width: 220,
                    margin: 2,
                    color: { dark: '#151d19', light: '#e9eee2' }
                  })
                );
              } catch {
                // The invitation links remain usable if the optional QR renderer cannot load.
                setQr('');
              }
            }, 'Device invitation created');
          }}
        >
          <Field label="Device label">
            <input name="label" maxLength={60} placeholder="My phone" />
          </Field>
          <Button type="submit" busy={action.busy}>
            Create invitation
          </Button>
        </form>
        {enrollment && (
          <div className="stack management-filter">
            {qr && (
              <img
                src={qr}
                width={220}
                height={220}
                alt="Scan to pair this device with your garden computer"
              />
            )}
            <SecretResult label="Device invitation" value={enrollment.webUri} link />
            <a className="button" href={enrollment.uri}>
              Open in installed app
            </a>
            <p className="muted">
              Expires {date(enrollment.expiresAt)}. Share it only with your own device.
            </p>
            <Button
              onClick={() => {
                setEnrollment(null);
                setQr('');
              }}
            >
              Hide invitation
            </Button>
          </div>
        )}
        <ResourceState resource={enrollments} />
        {enrollments.value?.map((item) => (
          <div className="management-item" key={item.id}>
            <div>
              <strong>{item.label}</strong>
              <p className="muted">Expires {date(item.expiresAt)}</p>
            </div>
            <Button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await del(`/v1/devices/enrollments/${item.id}`);
                  if (enrollment?.id === item.id) {
                    setEnrollment(null);
                    setQr('');
                  }
                }, 'Invitation revoked')
              }
            >
              Revoke invitation
            </Button>
          </div>
        ))}
        <ActionFeedback action={action} />
      </Section>
      <DeviceDraftSettings />
      <Section title="Signed-in devices">
        <ResourceState resource={sessions} />
        <div className="management-list">
          {sessions.value?.map((session) => (
            <article className="management-item" key={session.id}>
              <div>
                <strong>
                  {session.deviceLabel || 'Device'}
                  {session.current ? ' · this device' : ''}
                </strong>
                <p className="muted">Signed in {date(session.createdAt)}</p>
                {session.lastSeenAt && (
                  <p className="management-metadata muted">Last seen {date(session.lastSeenAt)}</p>
                )}
              </div>
              <ConfirmButton
                label="Sign out"
                description={`End access for ${session.current ? 'this device' : session.deviceLabel || 'this session'}. It will need a passkey to sign in again. Unsynced drafts encrypted for that session will no longer be recoverable.`}
                action={() => revokeDeviceSession(session.id, sessions.refresh)}
              />
            </article>
          ))}
        </div>
      </Section>
      <Section
        title="API tokens"
        description="Scoped access for your own scripts and integrations. A token's secret is shown only when it is created."
      >
        <ResourceState resource={tokens} />
        <div className="management-list">
          {tokens.value?.map((token) => (
            <article className="management-item" key={token.id}>
              <div>
                <strong>{token.label}</strong>
                <p className="muted">
                  {token.prefix}… · expires {date(token.expiresAt)}
                </p>
                <p className="management-metadata muted">{token.scopes.join(', ')}</p>
                {token.lastUsedAt && (
                  <p className="management-metadata muted">Last used {date(token.lastUsedAt)}</p>
                )}
              </div>
              <ConfirmButton
                label="Revoke token"
                description={`Stop access for “${token.label}”. Scripts using it will need a new token.`}
                action={async () => {
                  await sensitive(() => del(`/v1/api-tokens/${token.id}`));
                  tokens.refresh();
                }}
              />
            </article>
          ))}
        </div>
        <details>
          <summary>Create a token</summary>
          <form
            className="stack management-filter"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const values = new FormData(form);
              void action.run(async () => {
                const selected = values.getAll('scope').map(String);
                if (!selected.length) throw new Error('Choose at least one permission.');
                const result = await sensitive(() =>
                  post<{ apiToken: ApiToken; token: string }>('/v1/api-tokens', {
                    label: fieldValue(values, 'label'),
                    scopes: selected,
                    expiresInDays: Number(values.get('expiry'))
                  })
                );
                setSecret({ label: `API token · ${result.apiToken.label}`, value: result.token });
                form.reset();
              }, 'Token created. Save its secret above.');
            }}
          >
            <div className="management-grid">
              <Field label="Token name">
                <input required name="label" maxLength={80} />
              </Field>
              <Field label="Expires in days">
                <input required type="number" name="expiry" min="1" max="365" defaultValue={90} />
              </Field>
            </div>
            <fieldset>
              <legend>Permissions</legend>
              <div className="management-grid">
                {scopes.map((scope) => (
                  <label className="management-check" key={scope}>
                    <input type="checkbox" name="scope" value={scope} />
                    {scope}
                  </label>
                ))}
              </div>
            </fieldset>
            <Button type="submit" busy={action.busy}>
              Create token
            </Button>
          </form>
        </details>
        <ActionFeedback action={action} />
      </Section>
      {account.value && (
        <Section title="Delete account">
          <p className="muted">
            This removes your account and requests deletion of your workspaces. Download your data
            before continuing.
          </p>
          <ConfirmButton
            label="Delete account"
            confirmText={account.value.user.username}
            description="Delete your account and workspace files from this deployment. Existing backup copies expire according to deployment retention. This cannot be undone from the interface."
            action={async () => {
              await sensitive(() =>
                del('/v1/account', { confirmUsername: account.value!.user.username })
              );
              onChange();
            }}
          />
        </Section>
      )}
    </>
  );
}
