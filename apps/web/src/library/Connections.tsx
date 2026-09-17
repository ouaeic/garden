import { useEffect, useRef, useState } from 'react';
import type {
  Connector,
  ConnectorAuditEvent,
  ConnectorTestResult,
  StartConnectorOAuthResponse
} from '@athanor/contracts';
import { del, get, post } from '../client.js';
import { Button, Dialog, Field } from '../ui.js';
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
import { date } from '../model.js';
import { connectionInput, oauthCompletion, secretValue } from './connection-input.js';

interface Definition {
  kind: string;
  name: string;
  description: string;
  dataAccess: string;
  tokenLocation: string;
  providerLogging: string;
  requirements?: string;
  scopes: Array<{ id: string; label: string; sideEffect: string }>;
}
export function ConnectionsLibrary({ onChange }: { onChange: () => void }) {
  const connections = useResource<Connector[]>('/v1/connectors');
  const catalog = useResource<Definition[]>('/v1/connectors/catalog');
  const accountSetup = useResource<{ redirectUrl: string }>('/v1/connectors/accounts/oauth/config');
  const audit = useResource<ConnectorAuditEvent[]>('/v1/connectors/audit?limit=100');
  const action = useAction();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('github');
  const [auth, setAuth] = useState('bearer');
  const [registration, setRegistration] = useState('dynamic');
  const nativeAccount = kind === 'google' || kind === 'microsoft';
  const usingOAuth = nativeAccount || (kind === 'mcp_http' && auth === 'oauth');
  const [authorization, setAuthorization] = useState<StartConnectorOAuthResponse | null>(null);
  const [oauthMessage, setOauthMessage] = useState('');
  const [tested, setTested] = useState<Record<string, ConnectorTestResult>>({});
  const popup = useRef<Window | null>(null);
  const definition = catalog.value?.find((item) => item.kind === kind);
  useEffect(() => {
    const complete = (event: MessageEvent) => {
      const completion = oauthCompletion(event, popup.current, window.location.origin);
      if (!completion) return;
      setOauthMessage(
        String(
          completion.message ?? (completion.ok ? 'Connected' : 'Authorization was not completed')
        )
      );
      setAuthorization(null);
      if (completion.ok) {
        setAdding(false);
        setAuthorization(null);
        connections.refresh();
        audit.refresh();
        onChange();
      }
    };
    window.addEventListener('message', complete);
    return () => window.removeEventListener('message', complete);
  }, [connections.refresh, audit.refresh, onChange]);
  useEffect(() => {
    if (!adding || !authorization) return;
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (Date.now() >= Date.parse(authorization.expiresAt)) {
        setAuthorization(null);
        setOauthMessage('This authorization link expired. Start again to connect the account.');
        return;
      }
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const value = await get<Connector[]>('/v1/connectors', { signal: controller.signal });
        if (!controller.signal.aborted) connections.setValue(value);
      } catch {
        // A lost polling response does not cancel the provider's authorization window.
      } finally {
        pending = false;
      }
    };
    const checkLater = () => {
      void check();
    };
    const timer = window.setInterval(checkLater, 5000);
    window.addEventListener('focus', checkLater);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', checkLater);
    };
  }, [adding, authorization, connections.setValue]);
  useEffect(() => {
    if (
      !authorization?.connectorId ||
      !connections.value?.some(
        (connection) => connection.id === authorization.connectorId && connection.enabled
      )
    )
      return;
    setAdding(false);
    setAuthorization(null);
    setOauthMessage('Account connected.');
    audit.refresh();
    onChange();
  }, [authorization, connections.value, audit.refresh, onChange]);
  const refresh = () => {
    connections.refresh();
    audit.refresh();
    onChange();
  };
  return (
    <>
      <Section
        title="Connected services"
        description="Curated connections with explicit access to your accounts."
      >
        <Button
          onClick={() => {
            action.reset();
            setAdding(true);
            setAuthorization(null);
            setOauthMessage('');
          }}
        >
          Add a connection
        </Button>
        <ResourceState resource={connections} />
        {connections.value?.map((connection) => (
          <article className="management-item" key={connection.id}>
            <div>
              <strong>{connection.label}</strong>
              <p className="muted">
                {catalog.value?.find((item) => item.kind === connection.kind)?.name ??
                  connection.kind}{' '}
                · {connection.enabled ? 'Enabled' : 'Disabled'} · {connection.authMode}
              </p>
              <p className="management-metadata muted">{connection.baseUrl}</p>
              <details>
                <summary>Granted access</summary>
                <ul>
                  {connection.scopes.map((scope) => (
                    <li key={scope}>
                      {catalog.value
                        ?.find((item) => item.kind === connection.kind)
                        ?.scopes.find((item) => item.id === scope)?.label ?? scope}
                    </li>
                  ))}
                </ul>
              </details>
              {tested[connection.id] && (
                <p
                  className={tested[connection.id]!.ok ? 'management-feedback' : 'error'}
                  role="status"
                >
                  {tested[connection.id]!.ok
                    ? `Verified ${tested[connection.id]!.accountLabel ?? 'connection'}`
                    : (tested[connection.id]!.failure?.message ?? 'Connection check failed')}{' '}
                  · {date(tested[connection.id]!.checkedAt)}
                </p>
              )}
            </div>
            <div className="row">
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const result = await post<ConnectorTestResult>(
                      `/v1/connectors/${connection.id}/test`
                    );
                    setTested((value) => ({ ...value, [connection.id]: result }));
                    audit.refresh();
                  }, '')
                }
              >
                Check connection
              </Button>
              <ConfirmButton
                label="Disconnect"
                description={`Remove “${connection.label}” and its saved credentials from Garden. You can also revoke the application in your provider account settings.`}
                action={async () => {
                  await sensitive(() => del(`/v1/connectors/${connection.id}`));
                  refresh();
                }}
              />
            </div>
          </article>
        ))}
        {connections.value?.length === 0 && (
          <p className="empty">Connect a service when your work needs one.</p>
        )}
        <ActionFeedback action={action} />
        {oauthMessage && (
          <p role="status" className="management-note">
            {oauthMessage}
          </p>
        )}
      </Section>
      <Section
        title="Connection activity"
        description="A record of what your connected services were asked to do."
      >
        <ResourceState resource={audit} />
        {audit.value?.length === 0 && <p className="muted">No connection activity yet.</p>}
        <div className="management-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>Connection</th>
                <th>Operation</th>
                <th>Outcome</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {audit.value?.map((event) => (
                <tr key={event.id}>
                  <td>
                    {connections.value?.find((connection) => connection.id === event.connectorId)
                      ?.label ?? 'Disconnected service'}
                  </td>
                  <td>{event.operation.replaceAll('_', ' ')}</td>
                  <td>
                    {event.outcome}
                    {event.statusCode ? ` · ${event.statusCode}` : ''}
                  </td>
                  <td>{date(event.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      {adding && (
        <Dialog title="Connect a service" onClose={() => setAdding(false)} wide>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const values = new FormData(form);
              let authorizationOpened = false;
              if (usingOAuth)
                popup.current = window.open(
                  'about:blank',
                  'athanor-connection',
                  'popup,width=620,height=720'
                );
              void action
                .run(
                  async () => {
                    const input = connectionInput(
                      values,
                      kind,
                      definition?.scopes.map((scope) => scope.id) ?? []
                    );
                    const { scopes } = input;
                    if (nativeAccount) {
                      const started = await sensitive(() =>
                        post<StartConnectorOAuthResponse>('/v1/connectors/accounts/oauth/start', {
                          provider: kind,
                          label: input.label,
                          scopes,
                          clientId: fieldValue(values, 'clientId'),
                          clientSecret: secretValue(values, 'clientSecret')
                        })
                      );
                      setAuthorization(started);
                      if (popup.current) {
                        popup.current.location.href = started.authorizationUrl;
                        authorizationOpened = true;
                      }
                      return;
                    }
                    if (kind === 'mcp_http' && auth === 'oauth') {
                      const started = await sensitive(() =>
                        post<StartConnectorOAuthResponse>('/v1/connectors/mcp/oauth/start', {
                          label: input.label,
                          scopes,
                          baseUrl: fieldValue(values, 'baseUrl'),
                          registration,
                          oauthScopes: fieldValue(values, 'oauthScopes')
                            .split(/\s+/)
                            .filter(Boolean),
                          ...(registration === 'static'
                            ? {
                                clientId: fieldValue(values, 'clientId'),
                                ...(secretValue(values, 'clientSecret')
                                  ? { clientSecret: secretValue(values, 'clientSecret') }
                                  : {})
                              }
                            : {})
                        })
                      );
                      setAuthorization(started);
                      if (popup.current) {
                        popup.current.location.href = started.authorizationUrl;
                        authorizationOpened = true;
                      }
                      return;
                    }
                    await sensitive(() => post('/v1/connectors', input));
                    form.reset();
                    setAdding(false);
                    refresh();
                  },
                  usingOAuth
                    ? 'Complete authorization in the service window'
                    : 'Connection verified and saved'
                )
                .then((ok) => {
                  if (!ok && !authorizationOpened) popup.current?.close();
                });
            }}
          >
            <ResourceState resource={catalog} />
            <div className="management-grid">
              <Field label="Service">
                <select
                  value={kind}
                  onChange={(event) => {
                    action.reset();
                    setKind(event.target.value);
                    setAuthorization(null);
                    setOauthMessage('');
                  }}
                >
                  {catalog.value?.map((item) => (
                    <option key={item.kind} value={item.kind}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Connection name">
                <input required name="label" maxLength={80} placeholder="My account" />
              </Field>
            </div>
            {definition && (
              <>
                <p>{definition.description}</p>
                {definition.requirements && (
                  <p className="management-note">{definition.requirements}</p>
                )}
              </>
            )}
            <div className="management-grid" key={`${kind}:${auth}:${registration}`}>
              {kind !== 'github' && !nativeAccount && (
                <Field label={kind === 'imap' ? 'Mailbox endpoint URL' : 'Service URL'}>
                  <input
                    required
                    name="baseUrl"
                    type="url"
                    placeholder={
                      kind === 'imap'
                        ? 'imaps://mail.example.com:993'
                        : 'https://service.example.com'
                    }
                  />
                </Field>
              )}
              {nativeAccount && (
                <>
                  <div className="management-note">
                    <p>
                      Use your own registered web application. Garden connects directly to the
                      account you select.
                    </p>
                    <p>
                      <a
                        href={
                          kind === 'google'
                            ? 'https://console.cloud.google.com/apis/credentials'
                            : 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open {kind === 'google' ? 'Google' : 'Microsoft'} app registration
                      </a>
                    </p>
                    <ResourceState resource={accountSetup} />
                    {accountSetup.value && (
                      <Field
                        label="Registered redirect URI"
                        hint="Copy this exact address into your provider's web app registration."
                      >
                        <input
                          readOnly
                          value={accountSetup.value.redirectUrl}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                      </Field>
                    )}
                    <p className="muted">
                      {kind === 'google'
                        ? 'Enable the Gmail and Calendar APIs for the access you select. Add yourself as a test user if the consent app is in testing.'
                        : 'Choose an application account type that includes your account. Use a Web redirect URI and create a client secret.'}
                    </p>
                  </div>
                  <Field label="Application client ID">
                    <input required name="clientId" autoComplete="off" />
                  </Field>
                  <Field label="Client secret">
                    <input
                      required
                      type="password"
                      name="clientSecret"
                      autoComplete="new-password"
                    />
                  </Field>
                </>
              )}
              {kind === 'mcp_http' && (
                <Field label="Authentication">
                  <select
                    value={auth}
                    onChange={(event) => {
                      action.reset();
                      setAuth(event.target.value);
                      setAuthorization(null);
                      setOauthMessage('');
                    }}
                  >
                    <option value="bearer">Token or no authentication</option>
                    <option value="oauth">OAuth sign-in</option>
                  </select>
                </Field>
              )}
              {(kind === 'github' || (kind === 'mcp_http' && auth === 'bearer')) && (
                <Field label={kind === 'github' ? 'Access token' : 'Bearer token · optional'}>
                  <input
                    name="token"
                    required={kind === 'github'}
                    type="password"
                    autoComplete="new-password"
                  />
                </Field>
              )}
              {['webdav', 'imap', 'caldav'].includes(kind) && (
                <>
                  <Field label="Username">
                    <input required name="username" autoComplete="off" />
                  </Field>
                  <Field label="App password">
                    <input required name="password" type="password" autoComplete="new-password" />
                  </Field>
                </>
              )}
              {kind === 'imap' && (
                <>
                  <Field label="From address">
                    <input required name="fromAddress" type="email" />
                  </Field>
                  <Field label="From name · optional">
                    <input name="fromName" />
                  </Field>
                  <Field label="SMTP hostname">
                    <input required name="smtpHost" />
                  </Field>
                  <Field label="SMTP port">
                    <input
                      required
                      type="number"
                      name="smtpPort"
                      min="1"
                      max="65535"
                      defaultValue={465}
                    />
                  </Field>
                </>
              )}
              {kind === 'caldav' && (
                <Field label="Calendar account email">
                  <input required type="email" name="address" />
                </Field>
              )}
              {kind === 'mcp_http' && auth === 'oauth' && (
                <>
                  <Field label="Client registration">
                    <select
                      value={registration}
                      onChange={(event) => setRegistration(event.target.value)}
                    >
                      <option value="dynamic">Automatic</option>
                      <option value="static">Registered client</option>
                    </select>
                  </Field>
                  <Field
                    label="OAuth scopes · optional"
                    hint="Space-separated scopes required by the service."
                  >
                    <input name="oauthScopes" />
                  </Field>
                  {registration === 'static' && (
                    <>
                      <Field label="Client ID">
                        <input required name="clientId" />
                      </Field>
                      <Field label="Client secret · optional">
                        <input type="password" name="clientSecret" autoComplete="new-password" />
                      </Field>
                    </>
                  )}
                </>
              )}
            </div>
            <fieldset key={kind}>
              <legend>Access to grant</legend>
              <div className="stack">
                {definition?.scopes.map((scope) => (
                  <label className="library-connector-scope" key={scope.id}>
                    <input
                      type="checkbox"
                      name="scope"
                      value={scope.id}
                      defaultChecked={scope.sideEffect === 'read'}
                    />
                    <span>{scope.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {definition && (
              <details>
                <summary>Where data and credentials go</summary>
                <p>{definition.dataAccess}</p>
                <p>{definition.tokenLocation}</p>
                <p>{definition.providerLogging}</p>
              </details>
            )}
            {authorization && (
              <div className="management-note">
                <p>
                  Authorization at {authorization.authorizationHost} expires{' '}
                  {date(authorization.expiresAt)}.
                </p>
                <Button
                  onClick={() => {
                    popup.current = window.open(
                      authorization.authorizationUrl,
                      'athanor-connection',
                      'popup,width=620,height=720'
                    );
                  }}
                >
                  Open authorization
                </Button>
                <Button
                  onClick={() => {
                    connections.refresh();
                    audit.refresh();
                  }}
                >
                  Check for completed connection
                </Button>
              </div>
            )}
            <Button type="submit" className="primary" busy={action.busy}>
              {usingOAuth ? 'Choose account and connect' : 'Verify and connect'}
            </Button>
            <ActionFeedback action={action} />
            {oauthMessage && <p role="status">{oauthMessage}</p>}
          </form>
        </Dialog>
      )}
    </>
  );
}
