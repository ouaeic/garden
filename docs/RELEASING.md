# Releasing garden clients

This document covers client artifacts. The Linux server is installed from reviewed source; it is not
distributed as an image, container, or virtual machine.

## Release boundary

A pushed `vX.Y.Z` tag starts the draft-only release workflow. It:

1. requires the root package, desktop package, Tauri configuration, Cargo manifest, and tag to use
   the same strict semantic version;
2. repeats dependency-license, generic-client configuration, and native-client tests;
3. compiles the release commit into every native client so its SSH installer verifies both the
   bootstrap checksum and exact downloaded Git revision;
4. builds Linux x64, Linux ARM64, macOS universal, Windows x64, a four-ABI Android APK/AAB, and an
   iOS arm64 IPA on GitHub-hosted runners;
5. requires protected macOS, Windows, Android, and iOS distribution credentials before those
   platform jobs can complete;
6. audits the final native binaries and mobile packages, not only their source configuration;
7. attaches every package to one draft GitHub release; and
8. attaches a `SHA256SUMS` manifest only after every platform job succeeds.

Workflow actions are pinned to full commit hashes. Checkout credentials are not persisted. A failed
platform build leaves the release in draft and prevents checksum completion.

## Prepare

1. Update all four version fields checked by `pnpm release:check`.
2. Add user-visible changes and known limitations to the release notes.
3. Run:

   ```bash
   pnpm install --frozen-lockfile
   CI=true pnpm check
   pnpm license:rust
   pnpm release:check
   cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
   actionlint .github/workflows/verify.yml .github/workflows/release.yml
   ```

4. Review the exact committed tree and create an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "garden vX.Y.Z"
   git push origin main vX.Y.Z
   ```

Do not reuse or move a release tag.

## Required acceptance before publishing the draft

- Verify `SHA256SUMS` from a separately downloaded copy of every asset.
- Install each package on a clean supported operating system.
- Pair against a server whose URL was not compiled into the client.
- Complete first-owner registration and create a passkey.
- On mobile, complete system-browser authorization against a hostname with trusted HTTPS; confirm
  the matching code, fresh passkey ceremony, separate app session, enrollment, recovery, and
  sensitive-action verification. Refuse an unrelated browser URL and a reused authorization.
- Restart the client and prove session persistence without retaining the one-time owner code.
- Change the server's reachable address and prove pinned-identity reconnect.
- Exercise task streaming, file download, media display, preview, browser/desktop takeover, and a
  non-replayable request during a forced disconnect.
- Confirm the packaged client exposes no remote Tauri IPC capability.
- On Android, verify all intended ABIs, exact permission and backup policy, exact localhost
  cleartext exception, 16 KiB package/64-bit ELF alignment, and release signature.
- On iOS, verify the final IPA identity, arm64 binary, exact localhost and Bonjour policy, deep-link
  scheme, privacy declarations, App Store provisioning profile, entitlements, and code signature.
- On macOS, verify the exact bundle identity/privacy/localhost policy, universal architecture,
  build-path and secret scanning, strict Developer ID team identity, notarization, Gatekeeper,
  and stapling for both the app and DMG. On Windows, verify every executable and installer has a
  valid timestamped Authenticode signature.
- Run the no-content log canary and release security checklist.

## Protected signing configuration

The release workflow is fail-closed. Configure these as reviewer-protected repository or environment
secrets; never place them in source, logs, artifacts, or a developer `.env`:

| Platform | Required protected secrets                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `GARDEN_MACOS_CERTIFICATE`, `GARDEN_MACOS_CERTIFICATE_PASSWORD`, `GARDEN_APPLE_ID`, `GARDEN_APPLE_APP_PASSWORD`, `GARDEN_APPLE_TEAM_ID` |
| Windows  | `GARDEN_WINDOWS_CERTIFICATE`, `GARDEN_WINDOWS_CERTIFICATE_PASSWORD`                                                                     |
| Android  | `GARDEN_ANDROID_KEYSTORE_BASE64`, `GARDEN_ANDROID_KEYSTORE_PASSWORD`, `GARDEN_ANDROID_KEY_ALIAS`, `GARDEN_ANDROID_KEY_PASSWORD`         |
| iOS      | `GARDEN_IOS_CERTIFICATE`, `GARDEN_IOS_CERTIFICATE_PASSWORD`, `GARDEN_IOS_MOBILE_PROVISION`, `GARDEN_APPLE_TEAM_ID`                      |

The macOS certificate must be a Developer ID Application certificate; the Apple password must be an
app-specific password so Tauri can notarize and staple the direct-download artifacts. The Windows
certificate is a base64-encoded PFX and is imported only into the ephemeral runner account. Android
uses a base64-encoded release keystore. iOS uses the manual Tauri signing inputs: base64-encoded
Apple Distribution P12 and App Store Connect provisioning profile.

Local Android builds may be unsigned and local macOS builds may be ad-hoc for testing. They are
explicitly rejected by the protected release path. Store submission and review remain operator
actions outside the source repository.

Client updates deliberately use checksum-verified, platform-signed manual downloads. garden does
not ship a mutable updater feed or an additional updater signing root. This keeps the first public
release independent of a hosted control service; a future release may change that boundary only
through an explicit, reviewed threat-model and migration decision.

## What each client needs to build

Worth stating because the obvious check gives the wrong answer. `xcodebuild -version` fails on a
machine with only the Command Line Tools installed, and it is tempting to read that as "no Apple
target can be built here". It is not what it means: it reports where `xcode-select` points, not what
the machine can compile.

| Client  | Needs                                      | Buildable with Command Line Tools alone |
| ------- | ------------------------------------------ | --------------------------------------- |
| macOS   | macOS SDK, `aarch64-apple-darwin`          | **Yes** — confirmed, `.app` and `.dmg`  |
| iOS     | the iPhoneOS SDK, which ships inside Xcode | No                                      |
| Android | Android SDK and NDK, `ANDROID_HOME` set    | N/A — no Apple toolchain involved       |
| Windows | the MSVC toolchain, on Windows             | N/A                                     |

`pnpm --filter @garden/desktop native:build` produces a signed `.app` and a `.dmg` with nothing but
the Command Line Tools: the SDKs under `/Library/Developer/CommandLineTools/SDKs` are enough, and
`build-native.mjs` sets an ad-hoc signing identity when no Apple identity is configured, so a local
build is launchable without a developer account. Notarisation is skipped and says so.

iOS is the one that genuinely cannot: `xcrun --sdk iphoneos --show-sdk-path` reports the SDK cannot
be located, and a `cargo build --target aarch64-apple-ios` dies on the same thing. The
`aarch64-apple-ios` Rust target being installed is not sufficient and is what makes this look ready
— the target is a compiler backend, while the SDK and headers live inside `Xcode.app`.

## Declared operating-system floors

Reviewed 13 August 2026. These four numbers are a decision, not a default. Each is asserted twice:
once in `apps/desktop/verify-native-config.mjs`, which needs no build and therefore runs on every
`pnpm check`, and once in the artifact verifier for that platform, which reads the number back out
of the package that is about to be published.

| Platform | Floor          | Why this number                                                                                                       |
| -------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Android  | `minSdk 26`    | A deliberate raise above Tauri's configuration default of 24. No external rule constrains it.                         |
| Android  | `targetSdk 36` | Which behaviour changes the app declares it was written for; a lower number asks for older security defaults.         |
| iOS      | `15.0`         | The oldest deployment target Xcode 27 will build. Range is 15.0 to 27.0.                                              |
| macOS    | `12.0`         | The oldest deployment target Xcode 27 will build, and the oldest the macOS 27 SDK back-deploys a universal binary to. |

The macOS floor is confirmed in a built artifact rather than only in configuration: a local
`native:build` produces an `garden.app` whose `Info.plist` carries `LSMinimumSystemVersion 12.0`,
ad-hoc signed with the hardened runtime, and `verify-macos-artifact.mjs` accepts it.

macOS was the one that was wrong. No `minimumSystemVersion` was declared at all, so the bundle
inherited Tauri's default of `10.13` and the artifact verifier ratified it by asserting only
`>= 10.13`. That number was never chosen and could not have been honoured: Tauri supports macOS
10.15 and newer, `rustc --print=deployment-target` reports `11.0` for `aarch64-apple-darwin`, and
the key is documented as setting `MACOSX_DEPLOYMENT_TARGET` as well as `LSMinimumSystemVersion`. A
10.13 or 10.14 Mac would have been offered an install of a binary whose own toolchain never targeted
it. `12.0` is the lowest value that no part of the toolchain contradicts.

Both Apple floors are now exact-match assertions rather than `>=`. A lower bound cannot detect the
failure these invariants exist to catch, which is a regenerated project silently shipping a
different target than the one that was agreed.

Windows declares no floor, which is correct rather than an oversight. Tauri states support for
Windows 7 and later, the default `webviewInstallMode` bootstraps the WebView2 runtime from the
installer, `minimumWebview2Version` is unset, and no store rule applies to a direct download.

**`targetSdk` matters here for what the operating system does, not for what a store permits.**
garden is distributed as a direct download and is not submitted to any store, so the target-API
rule that forces most projects to move is not what is pushing on this number. What is: Android reads
`targetSdk` as a declaration of which behaviour changes the app has been written for, and runs an
app that declares less under the older, laxer defaults. Every one of those defaults that matters
here is a security default — scoped storage, the restrictions on implicit intents, foreground
service types. A client that reaches an owner's private server over their local network should not
be asking the system for the 2017 rules.

So the review cadence is Android's own, not a deadline. Android 17 is API 37; on the annual cadence
that is the next one to consider, around mid-2027. Raising `targetSdk` is a behaviour change rather
than a number change — API 37 gates local-network access behind a runtime permission, which this
client needs for the Bonjour discovery declared in `Info.plist`. Budget a real device test for it.

For reference if that ever changes: a store submission would have required API 36 from 31 August
2026, which this already meets.

`minSdk 26` has nothing external pushing on it at all, and for a directly distributed app there is
no install-base report to consult either — the Play Console figure other projects use does not exist
for a build nobody downloads through a store. So 26 is this project's own choice and stays one until
somebody has a reason: it costs whatever compatibility shims API 26 to 36 imply and buys back
devices on Android 8 and 9. Raise it when a specific API is wanted, not on a version-share article.

## Install verification

Download the release and manifest into one empty directory, then run the platform's SHA-256 tool:

```bash
sha256sum --check SHA256SUMS
```

On macOS use `shasum -a 256 -c SHA256SUMS`. Windows users can compare
`Get-FileHash -Algorithm SHA256` output to the manifest.
