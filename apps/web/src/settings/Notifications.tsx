import { useEffect, useState } from 'react';
import { del, patch, post, put } from '../client.js';
import { Button, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  SecretResult,
  fieldValue,
  sensitive,
  useAction,
  useResource
} from '../management.js';
import { date } from '../model.js';
import { nativeCapabilities, requestNativeNotifications } from '../native.js';

interface NotificationPreferences {
  kinds: {
    approvalRequired: boolean;
    taskFinished: boolean;
    spendPaused: boolean;
    agentMessage: boolean;
    takeoverNeeded: boolean;
  };
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursAllowApprovals: boolean;
  timeZone: string;
}
interface Destination {
  kind: string;
  botUsername: string;
  paired: boolean;
  verifiedAt: string | null;
  disabledAt: string | null;
  redact: boolean;
  pairingPending: boolean;
  pairingExpiresAt: string | null;
}
interface Pairing {
  botUsername: string;
  pairingUrl: string;
  expiresAt: string;
}
const kinds = {
  approvalRequired: 'Approvals',
  taskFinished: 'Finished work',
  spendPaused: 'Spending pauses',
  agentMessage: 'Messages from your agent',
  takeoverNeeded: 'Computer takeover'
} as const;

export function NotificationSettings() {
  const settings = useResource<NotificationPreferences>('/v1/notifications/settings');
  const config = useResource<{ enabled: boolean; publicKey: string | null }>(
    '/v1/notifications/config'
  );
  const destinations = useResource<Destination[]>('/v1/notifications/destinations');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairingSeenPending, setPairingSeenPending] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [nativeNotifications, setNativeNotifications] = useState(false);
  const [nativeGranted, setNativeGranted] = useState(false);
  const action = useAction(() => {
    settings.refresh();
    destinations.refresh();
  });
  const supported =
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window;
  useEffect(() => {
    let mounted = true;
    void nativeCapabilities()
      .then((capabilities) => {
        if (mounted) setNativeNotifications(Boolean(capabilities?.notifications));
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    if (!supported) return;
    let mounted = true;
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => {
        if (mounted) setSubscribed(Boolean(subscription));
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [supported]);
  const phone = destinations.value?.[0];
  useEffect(() => {
    if (!pairing) return;
    if (phone?.pairingPending) setPairingSeenPending(true);
    if (pairingSeenPending && phone?.paired && !phone.pairingPending) {
      setPairing(null);
      setPairingSeenPending(false);
      return;
    }
    const timer = setInterval(destinations.refresh, 5000);
    return () => clearInterval(timer);
  }, [pairing, pairingSeenPending, phone, destinations.refresh]);
  const togglePush = async () => {
    if (!supported) throw new Error('This browser does not support push notifications.');
    if (subscribed) {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await del('/v1/notifications/subscriptions', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setSubscribed(false);
      return;
    }
    if (!config.value?.enabled || !config.value.publicKey)
      throw new Error('Push is not configured on this server.');
    if ((await Notification.requestPermission()) !== 'granted')
      throw new Error('Allow notifications in your browser settings, then try again.');
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const raw = config.value.publicKey.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '='));
    const key = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key
      }));
    await post('/v1/notifications/subscriptions', subscription.toJSON());
    setSubscribed(true);
  };
  return (
    <>
      <Section title="This device" description="Receive a useful nudge when work needs you.">
        <ResourceState resource={config} />
        <p className="muted">
          {!supported
            ? 'Push is unavailable in this browser. You can still connect a phone below.'
            : subscribed
              ? 'Notifications are enabled on this device.'
              : config.value?.enabled
                ? 'Notifications are currently off on this device.'
                : 'Push notifications are not configured on this server.'}
        </p>
        <Button
          disabled={action.busy || !supported || (!subscribed && !config.value?.enabled)}
          onClick={() =>
            void action.run(
              togglePush,
              subscribed ? 'Device notifications turned off' : 'Device notifications enabled'
            )
          }
        >
          {subscribed ? 'Turn off on this device' : 'Enable on this device'}
        </Button>
        <ActionFeedback action={action} />
      </Section>
      {nativeNotifications && (
        <Section
          title="Native app notifications"
          description="Show notices from garden while this app is running. Android background delivery is not included in this beta."
        >
          <Button
            disabled={nativeGranted}
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                const granted = await requestNativeNotifications();
                setNativeGranted(granted);
                if (!granted)
                  throw new Error(
                    'Notifications were not allowed. Enable garden in your operating system’s notification settings.'
                  );
              }, 'Native notifications allowed')
            }
          >
            {nativeGranted ? 'Native notifications allowed' : 'Allow native notifications'}
          </Button>
          <p className="muted">You can change this permission in your operating system settings.</p>
          <ActionFeedback action={action} />
        </Section>
      )}
      <Section title="What reaches you">
        <ResourceState resource={settings} />
        {settings.value && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(() =>
                put('/v1/notifications/settings', {
                  kinds: Object.fromEntries(
                    Object.keys(kinds).map((kind) => [kind, form.has(kind)])
                  ),
                  quietHoursStart: fieldValue(form, 'start') || null,
                  quietHoursEnd: fieldValue(form, 'end') || null,
                  quietHoursAllowApprovals: form.has('quietApprovals')
                })
              );
            }}
          >
            <div className="management-grid">
              {Object.entries(kinds).map(([key, label]) => (
                <label className="management-check" key={key}>
                  <input
                    type="checkbox"
                    name={key}
                    defaultChecked={settings.value!.kinds[key as keyof typeof kinds]}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="management-grid">
              <Field label="Quiet hours start">
                <input
                  type="time"
                  name="start"
                  defaultValue={settings.value.quietHoursStart ?? ''}
                />
              </Field>
              <Field label="Quiet hours end">
                <input type="time" name="end" defaultValue={settings.value.quietHoursEnd ?? ''} />
              </Field>
            </div>
            <p className="muted">
              Times use {settings.value.timeZone}. Leave both empty for no quiet hours.
            </p>
            <label className="management-check">
              <input
                name="quietApprovals"
                type="checkbox"
                defaultChecked={settings.value.quietHoursAllowApprovals}
              />
              Allow approval requests during quiet hours
            </label>
            <Button type="submit" busy={action.busy}>
              Save notification preferences
            </Button>
            <ActionFeedback action={action} />
          </form>
        )}
      </Section>
      <Section
        title="Connect a phone"
        description="Receive notices and answer decisions through your own Telegram bot."
      >
        <ResourceState resource={destinations} />
        {phone && (
          <div className="management-note">
            <strong>@{phone.botUsername}</strong>
            <p>
              {phone.disabledAt
                ? 'Paused'
                : phone.paired
                  ? 'Paired and ready'
                  : 'Waiting for pairing'}
              {phone.verifiedAt && ` · paired ${date(phone.verifiedAt)}`}
            </p>
            {phone.pairingPending && phone.pairingExpiresAt && (
              <p>Pairing expires {date(phone.pairingExpiresAt)}</p>
            )}
          </div>
        )}
        <form
          className="stack management-filter"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const values = new FormData(form);
            void action.run(async () => {
              const result = await sensitive(() =>
                post<Pairing>('/v1/notifications/destinations/telegram', {
                  botToken: fieldValue(values, 'botToken')
                })
              );
              setPairing(result);
              form.reset();
            }, 'Open the pairing link on your phone');
          }}
        >
          <Field
            label={phone ? 'Replace bot token' : 'Bot token'}
            hint="Stored encrypted on your server. The bot must belong to you."
          >
            <input required name="botToken" type="password" autoComplete="new-password" />
          </Field>
          <Button type="submit" busy={action.busy}>
            {phone ? 'Connect replacement bot' : 'Connect bot'}
          </Button>
        </form>
        {pairing && (
          <>
            <SecretResult label="Pairing link" value={pairing.pairingUrl} link />
            <p className="muted">
              Expires {date(pairing.expiresAt)}. Open it in Telegram and start the bot.
            </p>
          </>
        )}
        {phone && (
          <>
            <div className="row">
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    async () =>
                      setPairing(
                        await sensitive(() =>
                          post<Pairing>('/v1/notifications/destinations/telegram/pairing')
                        )
                      ),
                    'New pairing link created'
                  )
                }
              >
                Pair another phone
              </Button>
              <Button
                disabled={action.busy || !phone.paired}
                onClick={() =>
                  void action.run(
                    () => post('/v1/notifications/destinations/telegram/test'),
                    'Test message sent'
                  )
                }
              >
                Send test message
              </Button>
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () =>
                      patch('/v1/notifications/destinations/telegram', {
                        disabled: !phone.disabledAt
                      }),
                    phone.disabledAt ? 'Phone notifications resumed' : 'Phone notifications paused'
                  )
                }
              >
                {phone.disabledAt ? 'Resume' : 'Pause'}
              </Button>
            </div>
            <label className="management-check management-filter">
              <input
                type="checkbox"
                checked={phone.redact}
                disabled={action.busy}
                onChange={(event) => {
                  const redact = event.target.checked;
                  void action.run(
                    () =>
                      sensitive(() => patch('/v1/notifications/destinations/telegram', { redact })),
                    redact ? 'Phone messages redacted' : 'Full phone message content enabled'
                  );
                }}
              />
              <span>
                Keep message details redacted
                <small className="muted">
                  Turning this off sends task details through the phone transport.
                </small>
              </span>
            </label>
            <ConfirmButton
              label="Disconnect phone"
              description="Remove this bot connection and revoke its answer token. The phone will no longer receive or answer decisions."
              action={async () => {
                await sensitive(() => del('/v1/notifications/destinations/telegram'));
                setPairing(null);
                destinations.refresh();
              }}
            />
          </>
        )}
        <ActionFeedback action={action} />
      </Section>
    </>
  );
}
