import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// The guarded native transport is copied verbatim; dependency upgrades require reviewing its
// binary/channel behavior and the cross-platform frame-injection contract before replacing it.
const ipcSource = JSON.parse(
  await readFile(new URL('./src-tauri/src/vendor/tauri-ipc-source.json', import.meta.url), 'utf8')
);
const cargoLock = await readFile(new URL('./src-tauri/Cargo.lock', import.meta.url), 'utf8');
const tauriVersion = cargoLock.match(/\[\[package\]\]\s+name = "tauri"\s+version = "([^"]+)"/)?.[1];
if (
  !tauriVersion ||
  tauriVersion !== ipcSource.version ||
  Object.keys(ipcSource.files).length !== 2
)
  throw new Error('Review the guarded IPC transport against the pinned Tauri dependency.');
for (const [name, expected] of Object.entries(ipcSource.files)) {
  const bytes = await readFile(new URL(`./src-tauri/src/vendor/${name}`, import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error(`The attributed upstream IPC transport changed: ${name}`);
}

const config = JSON.parse(
  await readFile(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8')
);
const capability = JSON.parse(
  await readFile(new URL('./src-tauri/capabilities/default.json', import.meta.url), 'utf8')
);
const loopbackNotifications = JSON.parse(
  await readFile(
    new URL('./src-tauri/capabilities/loopback-notifications.json', import.meta.url),
    'utf8'
  )
);
const loopbackNotificationsDesktop = JSON.parse(
  await readFile(
    new URL('./src-tauri/capabilities/loopback-notifications-desktop.json', import.meta.url),
    'utf8'
  )
);
const loopbackNative = JSON.parse(
  await readFile(new URL('./src-tauri/capabilities/loopback-native.json', import.meta.url), 'utf8')
);
const iosInfo = await readFile(new URL('./src-tauri/Info.ios.plist', import.meta.url), 'utf8');
const macosInfo = await readFile(new URL('./src-tauri/Info.plist', import.meta.url), 'utf8');
const iosIconDirectory = new URL('./src-tauri/icons/ios/', import.meta.url);
const generatedIosInfo = await readFile(
  new URL('./src-tauri/gen/apple/garden-desktop_iOS/Info.plist', import.meta.url),
  'utf8'
);
const generatedIosEntitlements = await readFile(
  new URL(
    './src-tauri/gen/apple/garden-desktop_iOS/garden-desktop_iOS.entitlements',
    import.meta.url
  ),
  'utf8'
);
const generatedIosProject = await readFile(
  new URL('./src-tauri/gen/apple/project.yml', import.meta.url),
  'utf8'
);
const generatedIosPbxProject = await readFile(
  new URL('./src-tauri/gen/apple/garden-desktop.xcodeproj/project.pbxproj', import.meta.url),
  'utf8'
);
export const iosBuildPhaseScript = generatedIosProject.match(/^\s*- script: (.+)$/m)?.[1];
const iosPbxBuildPhases = [
  ...generatedIosPbxProject.matchAll(/shellScript = ("(?:[^"\\]|\\.)*");/g)
]
  .map((match) => JSON.parse(match[1]))
  .filter((script) => script.includes('ios xcode-script'));
const iosCliCommand =
  'node "${SRCROOT:?}/../../../node_modules/@tauri-apps/cli/tauri.js" ios xcode-script ';
if (
  !iosBuildPhaseScript?.startsWith(iosCliCommand) ||
  !iosBuildPhaseScript.includes('--platform "${PLATFORM_DISPLAY_NAME:?}"') ||
  !iosBuildPhaseScript.includes('--sdk-root "${SDKROOT:?}"') ||
  !iosBuildPhaseScript.includes('--configuration "${CONFIGURATION:?}"') ||
  iosPbxBuildPhases.length !== 1 ||
  iosPbxBuildPhases[0] !== iosBuildPhaseScript
) {
  throw new Error(
    'Both generated iOS build phases must invoke the installed Tauri CLI from SRCROOT and quote scalar Xcode values.'
  );
}
const generatedIosIconDirectory = new URL(
  './src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/',
  import.meta.url
);
const generatedAndroidGradle = await readFile(
  new URL('./src-tauri/gen/android/app/build.gradle.kts', import.meta.url),
  'utf8'
);
function inspectPng(png, name) {
  const isPng =
    png.length >= 33 &&
    png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let hasTransparencyChunk = false;
  for (let offset = 8; isPng && offset + 12 <= png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'tRNS') hasTransparencyChunk = true;
    offset += 12 + length;
  }
  const colorType = png[25];
  if (!isPng || colorType === 4 || colorType === 6 || hasTransparencyChunk) {
    throw new Error(`The iOS App Store icon must be an opaque PNG: ${name}`);
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const iosIcons = (await readdir(iosIconDirectory)).filter((name) => name.endsWith('.png'));
for (const name of iosIcons) {
  const png = await readFile(new URL(name, iosIconDirectory));
  const sourceDimensions = inspectPng(png, name);
  const generated = await readFile(new URL(name, generatedIosIconDirectory));
  const generatedDimensions = inspectPng(generated, `generated/${name}`);
  if (
    sourceDimensions.width !== generatedDimensions.width ||
    sourceDimensions.height !== generatedDimensions.height
  ) {
    throw new Error(`The generated iOS icon dimensions are stale: ${name}`);
  }
}
// Each floor is argued in docs/RELEASING.md. They are checked here as well as in the artifact
// verifiers because a regenerated mobile project changes them without any build running.
if (
  config.bundle?.macOS?.minimumSystemVersion !== '12.0' ||
  config.bundle?.iOS?.minimumSystemVersion !== '15.0' ||
  config.bundle?.android?.minSdkVersion !== 26 ||
  !/^\s*minSdk = 26$/m.test(generatedAndroidGradle) ||
  !/^\s*targetSdk = 36$/m.test(generatedAndroidGradle) ||
  !/^\s*compileSdk = 36$/m.test(generatedAndroidGradle)
) {
  throw new Error(
    'A declared operating-system floor drifted from the agreed one: macOS 12.0, iOS 15.0, Android minSdk 26, Android targetSdk 36'
  );
}

const configuredUrl = config.app?.windows?.[0]?.url;
const remoteCapability = capability.remote;
const desktopSchemes = config.plugins?.['deep-link']?.desktop?.schemes;
const mobileLinks = config.plugins?.['deep-link']?.mobile;
const permissions = capability.permissions;
const notificationPermissions = loopbackNotifications.permissions;
const desktopNotificationPermissions = loopbackNotificationsDesktop.permissions;
const nativePermissions = loopbackNative.permissions;
/**
 * Every target garden packages a client for, and the reason the two capability files are read as a
 * pair rather than one at a time: what has to hold is that no shipped platform is left out of
 * `notification:default` on the loopback origin, whichever file happens to carry it.
 */
const notifiedPlatforms = [
  ...(loopbackNotifications.platforms ?? []),
  ...(loopbackNotificationsDesktop.platforms ?? [])
].sort();
const requiredIosTransportPolicy = [
  '<key>NSAppTransportSecurity</key>',
  '<key>NSExceptionDomains</key>',
  '<key>localhost</key>',
  '<key>NSExceptionAllowsInsecureHTTPLoads</key>',
  '<key>NSIncludesSubdomains</key>',
  '<false/>'
];
const requiredIosPairing = [
  'CFBundleURLTypes',
  'CFBundleURLSchemes',
  '<string>garden</string>',
  '<string>garden</string>'
];
const requiredApplePrivacyAndLan = [
  'NSBonjourServices',
  '<string>_garden._tcp</string>',
  'NSCameraUsageDescription',
  'NSLocalNetworkUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSPhotoLibraryUsageDescription'
];
const expectedDesktopIcons = [
  'icons/32x32.png',
  'icons/128x128.png',
  'icons/128x128@2x.png',
  'icons/icon.icns',
  'icons/icon.ico'
];
if (
  JSON.stringify(config.app?.security?.capabilities) !== JSON.stringify(['default']) ||
  configuredUrl !== undefined ||
  remoteCapability !== undefined ||
  config.app?.withGlobalTauri !== false ||
  JSON.stringify(desktopSchemes) !== JSON.stringify(['garden']) ||
  !Array.isArray(mobileLinks) ||
  mobileLinks.length !== 1 ||
  JSON.stringify(mobileLinks[0]?.scheme) !== JSON.stringify(['garden']) ||
  mobileLinks[0]?.appLink !== false ||
  !Array.isArray(permissions) ||
  !permissions.includes('core:event:default') ||
  !permissions.includes('deep-link:default') ||
  loopbackNotifications.local !== false ||
  JSON.stringify(loopbackNotifications.windows) !== JSON.stringify(['main']) ||
  JSON.stringify(loopbackNotifications.remote?.urls) !== JSON.stringify([]) ||
  JSON.stringify(loopbackNotifications.platforms) !== JSON.stringify(['android', 'iOS']) ||
  JSON.stringify(notificationPermissions) !== JSON.stringify(['notification:default']) ||
  loopbackNotificationsDesktop.local !== false ||
  JSON.stringify(loopbackNotificationsDesktop.windows) !== JSON.stringify(['main']) ||
  JSON.stringify(loopbackNotificationsDesktop.remote?.urls) !== JSON.stringify([]) ||
  JSON.stringify(loopbackNotificationsDesktop.platforms) !==
    JSON.stringify(['macOS', 'windows', 'linux']) ||
  JSON.stringify(desktopNotificationPermissions) !== JSON.stringify(['notification:default']) ||
  JSON.stringify(notifiedPlatforms) !==
    JSON.stringify(['android', 'iOS', 'linux', 'macOS', 'windows'].sort()) ||
  loopbackNative.local !== false ||
  JSON.stringify(loopbackNative.windows) !== JSON.stringify(['main']) ||
  JSON.stringify(loopbackNative.remote?.urls) !== JSON.stringify([]) ||
  JSON.stringify(nativePermissions) !==
    JSON.stringify([
      'allow-native-capabilities',
      'allow-open-authorization-browser',
      'allow-open-preview-browser',
      'allow-choose-folder',
      'allow-revoke-folder',
      'allow-list-local-folder',
      'allow-read-local-file'
    ]) ||
  JSON.stringify(config.bundle?.icon) !== JSON.stringify(expectedDesktopIcons) ||
  config.bundle?.iOS?.infoPlist !== 'Info.ios.plist' ||
  ![iosInfo, generatedIosInfo].every(
    (plist) =>
      requiredIosPairing.every((entry) => plist.includes(entry)) &&
      requiredApplePrivacyAndLan.every((entry) => plist.includes(entry)) &&
      requiredIosTransportPolicy.every((entry) => plist.includes(entry))
  ) ||
  iosInfo.includes('NSAllowsArbitraryLoads') ||
  iosInfo.includes('NSAllowsArbitraryLoadsInWebContent') ||
  iosInfo.includes('NSAllowsLocalNetworking') ||
  generatedIosInfo.includes('NSAllowsArbitraryLoads') ||
  generatedIosInfo.includes('NSAllowsArbitraryLoadsInWebContent') ||
  generatedIosInfo.includes('NSAllowsLocalNetworking') ||
  config.bundle?.macOS?.infoPlist !== 'Info.plist' ||
  !requiredApplePrivacyAndLan.every((entry) => macosInfo.includes(entry)) ||
  !requiredIosTransportPolicy.every((entry) => macosInfo.includes(entry)) ||
  macosInfo.includes('NSAllowsArbitraryLoads') ||
  macosInfo.includes('NSAllowsArbitraryLoadsInWebContent') ||
  macosInfo.includes('NSAllowsLocalNetworking') ||
  !/<dict\/>\s*<\/plist>\s*$/.test(generatedIosEntitlements) ||
  generatedIosEntitlements.includes('<key>') ||
  !generatedIosProject.includes('deploymentTarget:\n    iOS: 15.0') ||
  !generatedIosProject.includes('PRODUCT_BUNDLE_IDENTIFIER: org.garden.ai') ||
  !generatedIosPbxProject.includes('IPHONEOS_DEPLOYMENT_TARGET = 15.0;') ||
  (generatedIosPbxProject.match(/PRODUCT_BUNDLE_IDENTIFIER = org\.garden\.ai;/g) ?? []).length !==
    2 ||
  generatedIosPbxProject.includes('DEVELOPMENT_TEAM =') ||
  iosIcons.length !== 18 ||
  (await readdir(generatedIosIconDirectory)).filter((name) => name.endsWith('.png')).length !== 18
) {
  throw new Error(
    'The generic-client URL boundary, deep-link boundary, or mobile privacy declaration is invalid'
  );
}
console.log('Verified generic native client configuration');
