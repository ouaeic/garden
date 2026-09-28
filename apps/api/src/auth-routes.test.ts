import { describe, expect, test } from 'vitest';
import { deviceLabel } from './auth-routes.js';

const SAFARI_MACOS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/**
 * The one line an owner reads when they revoke a session.
 *
 * A packaged client is a webview, so it forwards a webview user agent and every device the owner
 * had signed in from an app was listed as "Safari on macOS" or "Chrome on Android" - the same
 * words as a browser tab, on the row where the whole question is which of these is which. The
 * proxy in the shell now inserts `x-garden-client`, and this is the half that reads it.
 */
describe('the name a session is listed under', () => {
  test('prefers the packaged client header over the webview user agent it forwards', () => {
    expect(deviceLabel({ 'user-agent': SAFARI_MACOS })).toBe('Safari on macOS');
    expect(
      deviceLabel({ 'user-agent': SAFARI_MACOS, 'x-garden-client': 'garden-macos/0.1.1' })
    ).toBe('garden app on macOS');
    expect(deviceLabel({ 'x-garden-client': 'garden-android/0.1.1' })).toBe(
      'garden app on Android'
    );
  });

  /*
   * Matched against a closed list rather than echoed, and this is the reason: any caller can set a
   * header, so a value that reached the row unread could be made to read like another line in the
   * list the owner is choosing from - "Safari on macOS" sitting under a session that is not one.
   * Everything unrecognised falls back to the user agent, including a repeated header, which
   * fastify hands over as an array.
   */
  test('falls back to the user agent for anything it cannot recognise, and never echoes it', () => {
    for (const forged of [
      'Safari on macOS',
      'garden-macos/0.1.1 <b>owner</b>',
      'garden-solaris/0.1.1',
      'garden-macos',
      `garden-macos/${'x'.repeat(64)}`,
      ''
    ]) {
      expect(deviceLabel({ 'user-agent': SAFARI_MACOS, 'x-garden-client': forged })).toBe(
        'Safari on macOS'
      );
    }
    expect(
      deviceLabel({
        'user-agent': SAFARI_MACOS,
        'x-garden-client': ['garden-macos/0.1.1', 'garden-linux/0.1.1']
      })
    ).toBe('Safari on macOS');
  });
});
