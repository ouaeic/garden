/**
 * A long conclusion split where its writer paused - at a dash, then a semicolon, then a colon with
 * a full clause before it - so the claim is set large and the rest of the sentence beneath it.
 */
export function leadOf(text: string): { lead: string; dek: string | null } {
  if (text.length <= 64) return { lead: text, dek: null };
  const split =
    /^(.{12,110}?)\s[—–]\s+(.+)$/.exec(text) ??
    /^(.{12,110}?);\s+(.+)$/.exec(text) ??
    /^(.{24,110}?):\s+(.+)$/.exec(text);
  const lead = split?.[1]?.trim();
  const dek = split?.[2]?.trim();
  if (!lead || !dek) return { lead: text, dek: null };
  return { lead, dek: dek.charAt(0).toUpperCase() + dek.slice(1) };
}
