# garden mobile

The Tauri 2 project in `apps/desktop/src-tauri` is the single audited native shell for macOS,
Windows, Linux, iOS, and Android. Mobile builds intentionally reuse the responsive server UI instead
of maintaining a divergent client.

No server URL or remote Tauri capability is compiled into the app. The owner imports an expiring
connection ticket after installation. A random-port loopback gateway pins the server public key,
follows its current endpoints, proxies HTTP/SSE/WebSockets, and keeps remote server pages outside the
native IPC boundary.

Run `pnpm native:configure` to verify that generic-client boundary before packaging. Initialize
platform projects with `pnpm --filter @garden/desktop ios:init` and
`pnpm --filter @garden/desktop android:init`, then use the corresponding `ios:build` or
`android:build` script. iOS requires full Xcode and a signing team. Android requires Android
Studio/SDK, NDK, Java, and signing configuration. Generated native platform directories may be
produced in a release workstation or CI because they include environment- and signing-specific
project data.

The responsive interface provides task monitoring, approvals, ordinary browser file upload,
camera/voice capture where the webview grants permission, and browser/desktop takeover. The
desktop-only folder broker is compiled out on mobile. Native share-sheet/document-picker and
APNs/FCM release packaging remain release gates and are not advertised by the runtime capability
response.

No inference engine or model weights are linked into any native binary.
