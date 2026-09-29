# Reaching your server from outside

## You probably do not need a relay

Most servers are reached directly. If a client can open a TCP connection to your computer on port
443, everything works and nothing else is involved: no third party, no extra hop, no traffic
allowance to run out.

A relay is for one situation only - inbound connections cannot arrive at all. That usually means
carrier-grade NAT, where your internet provider gives you an address you share with hundreds of
other subscribers and no port forward is possible. If that is not your situation, stop reading at
the end of the next two sections.

The relay ships **off**. Nothing dials anywhere, nothing registers anywhere, and no relay address
appears in your connection ticket until you turn it on yourself. There is no default relay and no
garden-operated relay.

## First choice: a direct address

Run `sudo garden doctor`. If it reports a globally routable address and nothing warns that only
private addresses were found, clients already reach you directly.

Two things to get right:

- **Inbound TCP 80 and 443 must arrive.** On a home connection that means a port forward on your
  router to this computer. The installer opens the ports in `ufw` or `firewalld` when either is
  active, but it cannot configure your router and cannot prove from the host itself that a request
  from the internet arrives.
- **Trusted TLS.** A certificate authority will now issue for a bare IP address, so a server with
  no domain at all can still have a green padlock:

  ```bash
  sudo garden certificate enable --agree-tos --email you@example.com
  ```

  Address certificates last 160 hours, so the renewal timer matters; `doctor` reports it.

Password sign-in works at a public IP address with trusted HTTPS. Optional passkeys require a
domain name; the WebAuthn standard does not allow an IP address as the relying-party identifier.
Native clients pin the server's identity and can also connect directly by address.

For a home server used only on your local network, native clients can use its reachable local
address. Browser access still needs a certificate trusted by the device for the address or name
you open. A private LAN address does not qualify for a public IP certificate. A domain with a
trusted certificate, or a locally managed certificate authority trusted on each device, is needed
for that browser setup. Garden does not install trust on your devices or configure your router.

## Second choice: a name that follows your address

If your address is public but changes, dynamic DNS gives you a stable name and keeps it pointed at
you. It is free and takes about a minute:

```bash
sudo garden ddns configure
```

Create a name at a provider first (duckdns.org and desec.io both work; Cloudflare works if you
already own a domain there). The command records the credential, publishes your current address,
makes the name the public origin, and puts it in the certificate. After that, browser sign-in works
and clients follow you across address changes.

`garden-network-watch` republishes on every address change, and `doctor` fails if the record has
not been refreshed for two days.

## Third choice: a relay

A relay is a small server with a public address that forwards connections to yours. Your computer
dials **out** to it and holds the connection open; clients connect to the relay, and the relay hands
those connections down the tunnel. Nothing has to arrive at your address, which is why this works
behind carrier-grade NAT.

**TLS terminates on your computer, not on the relay.** The relay moves encrypted bytes it cannot
read - it never holds a private key for your server and never sees a request, a URL, a header or a
token.

### Run your own

This is the recommended way and it should be the default assumption. A relay is one small program on
a cheap VPS - a 2-core machine with 4 GB of RAM and a 20 TB traffic allowance costs a few euros a
month, and one machine can serve you and everyone you would ever share it with.

The reason to prefer your own is not performance. It is that **the relay operator controls DNS for
the relay's domain**. They can point your relay hostname at a machine of their own, obtain a
perfectly valid certificate for it, and read everything a _browser_ client sends. The native clients
are immune because they pin your server's identity key and check it on every path. A plain browser
tab over someone else's relay is not.

`services/relay/README.md` has the operator instructions: the two DNS records, the configuration
file, the systemd unit, and the `invite` command that produces the single-use enrollment tokens.

### Use someone else's

Only with someone you would trust with the DNS for a domain you sign in through - see the paragraph
above. In practice that means a person, not a service.

You need two things from them: the relay's **hostname**, and a single-use **enrollment token**.

### Turning it on

In Settings, open the relay section, paste the hostname and the token, and confirm with your
password or optional passkey. The server enrolls, records the relay's public key so a later change of hands is refused,
and dials. Your relay address appears immediately and looks like:

```
https://ab3kqz7mn4pd2xw9tyv6su5rjh.relay.example.com
```

That label is derived from your server's own public key. The relay computes it and cannot be asked
for a different one, so nobody can squat your name, and enrolling with two relays gives you two
unrelated labels that cannot be linked back to the same computer.

From the server itself:

```bash
sudo garden relay status
```

`doctor` reports the relay too: whether it is on, whether it is connected, the address, the bytes
used against the allowance, and whether the operator has revoked you.

### Turning it off

```bash
sudo garden relay off
```

or the same switch in Settings. Either one closes the tunnel and removes the relay address from what
this computer advertises, in the same step - clients stop being offered an address that no longer
answers. The enrollment is kept, so turning it back on needs no new token. To discard it entirely,
use the remove action in Settings; your identity key stays, so re-enrolling with the same relay
gives you the same address back.

## What the relay operator can and cannot see

Can see, unavoidably:

- **Your label**, in cleartext, on every client connection. It is also in public certificate
  transparency logs, so treat it as public rather than as a secret.
- **Your home address and the address of every device you connect from.** This is a real privacy
  cost and it is the strongest argument for running your own relay.
- **Byte counts, connection counts, timings and session durations.** Enough to tell when you are
  working and roughly what you are doing - a terminal session and a file download look different
  even encrypted.
- **The TLS fingerprint** of the connecting client.

Cannot see:

- **Any byte of your traffic.** TLS terminates on your computer.
- Any URL, header, cookie, token, prompt, file or message.
- Even your server's certificate: the connection is TLS 1.3, which encrypts it.

## Limits worth knowing before you rely on it

- **The relay is a control path, not a media path.** A desktop preview moves roughly a gigabyte per
  hour. A typical per-server allowance of 25 GiB a month is about the control plane plus half an
  hour of desktop a day. `doctor` and Settings both show the bytes used so the ceiling is not a
  surprise; when you are on a local network, use the direct address for the desktop.
- **A browser reaching the relay hostname will warn.** Your server's certificate covers its own
  names and addresses, not the relay label, and issuing for the relay label is not yet wired up.
  The native clients are unaffected - they pin your server's identity key, which is the same key on
  every path.
- **One connection carries everything.** A terminal, a download and a preview share one TCP
  connection to the relay, so a lost packet stalls all of them briefly. Direct paths do not have
  this property.
- **A revoked enrollment is final.** If the operator revokes your label the server stops retrying,
  says so in `doctor`, and waits for you - a client that keeps hammering a relay that has refused it
  looks like an attack.

## Where the state lives

`/etc/garden/relay/` holds the identity key, the settings, and the last reported status. It is
readable only by the control account, it survives updates, and it travels in `sudo garden backup`
with the rest of the configuration. **The identity key is your address.** Losing it changes the
hostname every paired client holds, exactly as if you had moved house.
