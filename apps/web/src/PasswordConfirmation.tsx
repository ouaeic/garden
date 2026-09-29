import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Dialog, ErrorNotice, Field } from './ui';
import { post } from './client';

function PasswordConfirmation({ done }: { done: (error?: Error) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog title="Confirm it’s you" onClose={() => done(new Error('Confirmation cancelled'))}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void post('/v1/auth/password/step-up', { password })
            .then(() => done())
            .catch((cause: unknown) => {
              setError(cause);
              setBusy(false);
            });
        }}
      >
        <p>Enter your Garden password to continue with this account change.</p>
        <Field label="Password">
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <ErrorNotice error={error} />
        <Button type="submit" className="primary" busy={busy}>
          Continue
        </Button>
      </form>
    </Dialog>
  );
}

export function confirmPassword(): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return new Promise<void>((resolve, reject) => {
    root.render(
      <PasswordConfirmation
        done={(error) => {
          root.unmount();
          container.remove();
          if (error) reject(error);
          else resolve();
        }}
      />
    );
  });
}
