# garden-relay

A small rendezvous server so an garden box behind CGNAT, or on an address that keeps changing, can
still be reached. The box dials out and holds one connection open; clients connect to the relay and
the relay forwards bytes between the two. **TLS terminates on the box, not here.**

You probably do not need this. Read [Do you actually need a relay?](#do-you-actually-need-a-relay)
first.

---

## What the operator runs

One Node 24 process, one config file, one JSON registry file, two DNS records.

### 1. DNS

```
relay.example       A     203.0.113.10
relay.example       AAAA  2001:db8::10
*.relay.example     A     203.0.113.10
*.relay.example     AAAA  2001:db8::10
```

**Do not publish an HTTPS/SVCB record with an `ech=` parameter for this domain.** Encrypted Client
Hello encrypts the SNI, and SNI is the only thing the relay routes on. Publishing an ECHConfig
breaks every route at once.

### 2. A certificate for the relay's own hostname

This is only for the control connection that boxes dial in on — clients never see it and it is not
used for `*.relay.example`. Any ACME client will do:

```sh
certbot certonly --standalone -d relay.example
```

For a local smoke test without ACME:

```sh
node dist/cli.js dev-cert --host relay.example --out /etc/garden-relay/tls
```

Boxes pin this certificate's public key on first enrollment (trust on first use), so replacing it
with a different key pair is a re-pair event for every enrolled box. Renew the certificate, keep the
key.

### 3. Config

Copy `config.example.json` to `/etc/garden-relay.json` and set `relayDomain`, `tlsCertPath` and
`tlsKeyPath`. Everything else has a working default. Quotas are documented under
[Limits and defaults](#limits-and-defaults).

Generated apps use the separate `previewPort` listener from the example configuration. Allow that
TCP port through the relay firewall as well as the owner HTTPS port. It forwards encrypted traffic
to the box's preview-only TLS listener, configured by `RELAY_LOCAL_PREVIEW_PORT`; it must never
point at the owner application listener. Set `previewPort` to `null` only when app previews should
be unavailable through this relay. Client and relay negotiate this support before forwarding; a
client that has not advertised it is refused for previews. Existing owner and certificate-renewal
traffic keeps its own routes. Update the relay before using isolated preview links through it.

### 4. Run it

```sh
pnpm --filter @garden/relay build
node dist/cli.js serve --config /etc/garden-relay.json
```

A systemd unit, which is how it should actually run:

```ini
[Unit]
Description=garden-relay
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/garden-relay/dist/cli.js serve --config /etc/garden-relay.json
User=garden-relay
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
StateDirectory=garden-relay
LimitNOFILE=65535
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Also worth setting on the host: `net.ipv4.tcp_syncookies=1` and a raised `net.core.somaxconn`.

### 5. Let a box in

Registration is closed by default — there is no way to enroll without a token you minted:

```sh
node dist/cli.js invite --note "dan-basement" --ttl 24h
# arly1_hbxwy3dpmnqxi33qnrqwe3ttmfxhqzlomnxw2yldnfzws3q
```

The token is single use and hashed at rest; the plaintext is printed once and never stored. Paste it
into the box's relay settings along with the relay hostname. The box connects, proves it holds its
identity key, and gets back its permanent hostname.

### Day-to-day

```sh
node dist/cli.js peers                     # who is registered, how much they have used
node dist/cli.js revoke <label>            # delete a peer; its live session is dropped immediately
node dist/cli.js serve --no-registration   # refuse all enrollment, without editing the config
node dist/cli.js abuse --log /var/log/garden-relay.log \
                       --at 2026-07-30T14:12:00Z --client-ip 203.0.113.9
```

`abuse` maps a complaint back to a label. It only works if you turned on `logClientIps`, which is
off by default — see [What the relay can see](#what-the-relay-can-see).

All of these work against a running relay. The registry is a single JSON file
(`write temp → fsync → rename`) that the CLI and the running process both edit, and the relay
reconciles with it: an invite is picked up the moment a box tries to use it, and a `revoke` takes
effect within about five seconds, dropping the live session with it. Byte counters are flushed on
the same cadence, so an unclean shutdown loses at most five seconds of accounting. Editing the file
by hand — to change one peer's quota, say — works the same way; the relay takes your edits and keeps
its own counters.

Metrics are Prometheus text on `127.0.0.1:9095/metrics`. **Keep them on localhost.** Per-label byte
counters are exactly the traffic-analysis material this design otherwise avoids handing out.

---

## How it works

The box dials `relay.example:443` and completes a TLS 1.3 handshake in which it presents a
self-signed certificate whose public key _is_ its garden identity key. The relay ignores the
certificate chain entirely and looks the SHA-256 of the SubjectPublicKeyInfo up in its registry.

There is no challenge-response message, deliberately. TLS 1.3's `CertificateVerify` already signs
the whole handshake transcript, including the relay's freshly generated ServerHello random and key
share, so a recording of a successful connection cannot be replayed against a new one — and TLS 1.3
encrypts the client Certificate message, so a passive observer never learns which box is connecting.
A hand-rolled nonce exchange would give strictly less and add something else to get wrong.

Inside that connection the box speaks HTTP/2 as the client. It opens one long-lived control stream
(NDJSON both ways) and keeps a pool of eight _parked_ streams open. When a client arrives, the relay
grabs a parked stream, writes a small CBOR bind frame, and then it is a raw byte pipe. Parking is
what keeps latency down: there is no extra round trip to set up a connection even though the box is
the one that dialled out.

Client side, the relay reads the TLS ClientHello — reassembling it across records and TCP segments,
which is where naive SNI proxies break — and routes on SNI:

| SNI                                            | Result                                     |
| ---------------------------------------------- | ------------------------------------------ |
| `relay.example` with ALPN `garden-relay/1`     | a box dialling in; terminated here         |
| `<label>.relay.example`, registered and online | bind to that box's parked stream           |
| anything else                                  | TLS alert `unrecognized_name`, then closed |

Control traffic sharing port 443 with client traffic is deliberate: to a hostile network or a CGNAT
operator, a box's tunnel is indistinguishable from ordinary HTTPS.

### Labels

```
label = base32-lower-nopad(SHA256("garden-relay-label-v1\0" || u8(len(domain)) || domain
                                  || raw_ed25519_pubkey))[0:26]
```

The relay derives this; a box cannot request a name. 26 base32 characters is 130 bits. The domain is
mixed in, so the same box enrolled on two different relays gets two labels that cannot be linked.
The label carries no email, hostname or account name — nothing user-identifying at all.

### Port 80

Exists for two things only: ACME HTTP-01 as a fallback when TLS-ALPN-01 will not cooperate, and
HTTP→HTTPS redirects. It reads the request head, routes on `Host`, and forwards the bytes unchanged.
It is rate limited four times harder than 443. Set `"httpPort": null` to turn it off.

There is **no UDP listener and no QUIC**, which removes every amplification and reflection concern
outright. The consequence a box has to handle: suppress `Alt-Svc: h3` on connections that arrived
over the relay, or browsers will try HTTP/3 against a port with nothing on it and stall. The bind
frame tells the box which path a connection came in on.

---

## What the relay can see

TLS terminates on the box. The relay decrypts only the _tunnel's_ TLS; the traffic inside it is a
second, independent TLS session between the client and the box, and the relay has no key for it.

**Cannot see:** any payload byte. No URLs, headers, cookies, tokens or request bodies. Not even the
box's own certificate, because the box is TLS 1.3 only and TLS 1.3 encrypts the Certificate message.

**Can see, unavoidably:**

1. **The label**, in cleartext SNI, on every client connection — and so can anyone on the path
   between the client and the relay. ECH would fix this but the relay cannot publish an ECHConfig
   without breaking its own routing. This is not fixable in this architecture.
2. **Source IP addresses.** The relay learns the box's home address and the address of every device
   its owner connects from. This is a real leak. It is not logged by default (`logClientIps: false`)
   but it is necessarily observed.
3. **Traffic analysis.** Byte counts, timing, stream counts, session durations, time of day.
   Keystroke timing over an interactive terminal is a well-known attack class and the relay sits in
   the ideal position for it. Padding and pacing would cost more than they are worth here; the
   honest answer is that the exposure exists.
4. **Client TLS fingerprint** (JA3/JA4) and offered ALPN.

**Labels are not secret.** Certificate Transparency publishes every certificate issued for
`<label>.relay.example`, permanently and publicly. The set of a relay's users is enumerable no matter
what the relay does, which is why labels are high-entropy and carry no information.

### The hole that cannot be closed

**The relay operator controls DNS for `relay.example.`** They can point `<label>.relay.example` at a
machine they own, get a perfectly valid certificate for it, and man-in-the-middle any _browser_
client. CAA with `accounturi` does not help — they control the zone, and RFC 8657 §5.2 says not to
rely on it for this.

Who is protected:

- **Native and Tauri clients:** yes. They pin the identity public key, and the box uses the same key
  pair on every path, so the rule is always "pin the SPKI, not the certificate".
- **Installed PWA:** mostly. The shell is served from the service worker cache and the app runs its
  own identity challenge against a pinned key. First install is the trust window.
- **A plain browser tab visiting over the relay for the first time:** no. Nothing can be done.

**So: run your own relay.** It is a €4/month VPS and one Node process. Using someone else's is a
convenience, and it means trusting them not to do the above.

---

## Limits and defaults

Shipped defaults, all overridable per relay in the config and per peer in the registry file:

| Limit                          | Default       | Why                                                        |
| ------------------------------ | ------------- | ---------------------------------------------------------- |
| `global.maxPeers`              | 256           | A hobbyist relay serves friends, not the world             |
| `perPeer.concurrentStreams`    | 64            |                                                            |
| `perPeer.newStreamsPerMinute`  | 300           |                                                            |
| `perPeer.rateBps`              | 10 MiB/s      | Token bucket, 50 MiB burst                                 |
| `perPeer.monthlyBytes`         | 25 GiB        | warn 80% → shape to 1 Mbps at 100% → refuse at 150%        |
| `global.monthlyBytes`          | 15 TB         | Under a 20 TB plan with headroom; shapes every peer at 90% |
| `perSourceIp.newConnPerMinute` | 120, burst 60 | Keyed per /32 (v4) and per **/64** (v6)                    |
| `global.halfOpenPreSni`        | 2048          | Connections that have not yet produced a ClientHello       |
| Handshake deadline             | 3 s           | Then closed                                                |
| Registration                   | **closed**    | Invite tokens only                                         |

Quotas reset on the first of each calendar month, UTC. Going over shapes rather than cuts off,
because a box that goes dark mid-month is a support ticket whereas a slow one is a visible nudge that
still lets the owner reach the machine and fix whatever is burning bytes.

### What stops abuse

**It is not an open proxy.** The only reachable destinations are labels registered by an
authenticated peer. There is no `CONNECT`, and the relay never dials an address a client supplied.

**No amplification.** TCP only, no UDP. The relay writes nothing to an unrouted client except a
seven-byte TLS alert, so the pre-authorization response is smaller than the request that triggered
it. A failed or stalled handshake gets its socket cut rather than lingering.

**Bounded memory per connection.** Copy buffers are 32 KiB per direction. HTTP/2 flow control means a
slow client backpressures all the way to the box rather than accumulating in the relay. A peer's
worst-case inbound buffering is `concurrentStreams × 256 KiB`, and in practice far less. Half-closed
connections are reclaimed after `halfCloseLingerMs` so a client that vanishes cannot pin one of a
peer's stream slots.

**What it cannot stop:** a registered box hosting something abusive behind the relay's IP address.
The relay cannot inspect content — that is the entire point — so the only lever is `revoke`. This is
the single biggest reason not to run an open relay for strangers.

---

## Cost profile

Reference machine: 2 vCPU / 4 GB / 20 TB traffic, about €4/month.

**CPU is never the constraint.** There is no cryptography on the data path — the inner TLS is not
the relay's to decrypt — so this is a userspace byte copy. At 32 KiB reads, 1 Gbps is a few thousand
read/write pairs per second.

**Memory** scales with connections, and connections are cheap. An idle registered box costs one TLS
connection plus an HTTP/2 session plus eight parked streams. Node is not free here: a Node TLS
connection costs meaningfully more than a plain TCP one — measure on your own hardware before
planning for thousands of peers. At the shipped `maxPeers` of 256 this is not a consideration.

**Bandwidth is the actual bill**, and it is dominated by one thing:

| Workload                              | Rate           | Monthly at 1 h/day |
| ------------------------------------- | -------------- | ------------------ |
| Control, API, agent event stream      | ~1–10 MB/hour  | ~0.3 GB            |
| Terminal streaming                    | ~50–500 KB/min | ~1 GB              |
| Desktop preview (1080p JPEG at 2 fps) | ~1.15 GB/hour  | **~35 GB**         |
| VNC/H.264 at 1.5 Mbps                 | ~0.67 GB/hour  | ~20 GB             |

Providers meter egress only, and each relayed byte is one ingress plus one egress, so billed egress
is roughly the total user payload — not double it. 20 TB/month is about 61 Mbps sustained around the
clock.

**The desktop preview dominates by an order of magnitude.** At one hour of desktop viewing per box
per day, 20 TB supports a few hundred boxes; at four hours, well under two hundred. This is why the
per-peer default is 25 GiB — "control plane plus about half an hour of desktop a day" — and why
garden should prefer a direct or LAN path for the desktop stream even when the control session is
on the relay.

**Treat the relay as a control path, not a media path.**

---

## Do you actually need a relay?

In order of preference:

1. **A direct connection.** Let's Encrypt issues certificates for bare IP addresses now, so a box on
   a static public address can hold a browser-trusted certificate with no domain at all. No relay, no
   third party, nothing to trust.
2. **Dynamic DNS with your own name.** A 90-day certificate and a renewal loop.
3. **Your own relay.** One VPS, one process, this README.
4. **Someone else's relay.** Convenient, and it means trusting them with everything in
   [The hole that cannot be closed](#the-hole-that-cannot-be-closed).

Relaying is off by default on the box, and turning it on takes two deliberate actions: pasting an
invite token and a relay hostname. There is no default relay and no discovery.

---

## Development

```sh
pnpm --filter @garden/relay typecheck
pnpm --filter @garden/relay test
pnpm --filter @garden/relay build
```

`src/box-harness.ts` is a minimal box-side tunnel client. It is what the tests drive the relay with
and it is the executable specification for the real client in `packages/relay-client`: control
stream, park pool, bind frame, and the fact that a bound stream is handed over **paused** and the
consumer must start it reading.
