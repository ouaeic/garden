# Native beta clients

The generic Tauri client pairs with the owner's server after installation. Its Rust transport,
certificate pinning, local discovery and permission broker are shared by desktop and Android.
The workspace interface comes from that server and receives web updates independently of the
installed shell. No server address or model credential is compiled into a package.

## Build without a store account

Use the repository's pinned Node and pnpm toolchain. Desktop builds also need Rust and the
platform's Tauri build dependencies; Android builds need the Android SDK, NDK and a compatible JDK.

```sh
pnpm native:configure
pnpm --filter @garden/desktop beta:desktop
pnpm --filter @garden/desktop beta:android --target aarch64
```

The Android command produces an audited, signed APK for direct installation. On the first local
build it creates a persistent signing key in the gitignored `.garden/beta-signing` directory.
Back up that directory privately: subsequent APKs must use the same key to update an existing
installation. The signing key and password must never be attached to a release or committed.
An app-store developer account is not needed to create or sign the APK.

Beta clients pin server installation to their compiled source commit. The packaged installer
verifies both the bootstrap checksum and the checked-out revision before running it.

The macOS beta is ad-hoc signed and audited, without Developer ID or notarization. Windows beta
installers have no Authenticode certificate. Operating-system trust prompts remain part of these
beta installation paths. Linux packages need no commercial signing account. Public distribution
must follow the target platform's current installation rules.

`Build beta clients` in GitHub Actions is separate from the tagged distribution workflow. It
produces desktop artifacts without paid signing credentials. Android is selectable once the
persistent signing values have been placed in the repository's `GARDEN_ANDROID_*` secrets; CI
refuses to create a temporary key that would make the next build unable to update installed apps.
The workflow produces artifacts for review and does not publish them automatically. The tagged
distribution workflow retains its platform signing and notarization checks.

For native update discovery, reviewed installers can be attached to a public release tagged
`v<version>`, or a prerelease tagged `beta-<version>-<full source commit>`. Drafts and releases
without native packages are excluded from the update catalogue. Advance the package version
through the existing release checks when publishing an upgrade; client notices compare release
versions and do not offer a downgrade.

## Updates and notifications

The signed-in app checks the public Garden repository for updates. Catalogue requests contain
the installed source revision, never workspace content or credentials. Checks are shared and
cached on the owner's server. A failed lookup is reported as unknown. Server updates are applied
with `sudo garden update`, which keeps the existing backup, readiness and rollback process.

The web build carries a content-derived identity and a matching service-worker cache identity.
A changed web build offers a refresh; it never reloads an unsent draft automatically. Native
shell releases offer a download in the app and under Settings, Computer, maintenance.

Native task notices respect the owner's notification preferences and quiet hours while the app
is running. Android delivery after the app is suspended or closed is not implemented in this
beta. No Firebase service or shared notification relay is configured or bundled. Optional browser
Web Push and Telegram transports remain explicit opt-ins; those routes send notification data
through the selected external delivery service. Owners who require direct-only delivery can
leave those transports disabled.
