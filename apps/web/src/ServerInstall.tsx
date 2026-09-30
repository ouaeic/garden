import { useState } from 'react';
import { Copy, ExternalLink } from './icons';
import { localInstallerUrl } from './native.js';
import { Button, ErrorNotice } from './ui.js';
import './native.css';

const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/ouaeic/garden/v0.2.0/install.sh | sudo env GARDEN_REF=v0.2.0 sh';

export const serverInstallCommand = (revision: unknown): string =>
  typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision)
    ? `curl -fsSL https://raw.githubusercontent.com/ouaeic/garden/${revision}/install.sh | sudo env GARDEN_REF=${revision} GARDEN_EXPECTED_COMMIT=${revision} sh`
    : INSTALL_COMMAND;

const command = serverInstallCommand(
  typeof __GARDEN_SOURCE_REVISION__ === 'undefined' ? null : __GARDEN_SOURCE_REVISION__
);

export default function ServerInstall({ installerUrl }: { installerUrl?: string | null }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const installer = localInstallerUrl(installerUrl);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  };
  return (
    <section className="server-install">
      <h2>A home for your work.</h2>
      <p>
        Install garden on your Linux server. Your work, tools and model credentials stay on your
        computer.
      </p>
      {installer && (
        <a className="button primary" href={installer} rel="noreferrer">
          Open secure installer <ExternalLink size={15} />
        </a>
      )}
      {installer && (
        <p className="muted">
          The installer opens a separate local page to verify your server’s SSH identity and receive
          the credentials you enter.
        </p>
      )}
      <details open={!installer}>
        <summary>Install from your server’s terminal</summary>
        <pre>
          <code>{command}</code>
        </pre>
        <Button onClick={() => void copy()}>
          <Copy size={15} />
          {copied ? 'Copied' : 'Copy command'}
        </Button>
        <p className="muted">
          Run on a Linux server you control. The installer prints your address and one-time owner
          code when it finishes.
        </p>
      </details>
      <ErrorNotice error={error} />
    </section>
  );
}
