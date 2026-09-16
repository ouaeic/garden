/** Sign-in and account registration are ordinary navigation, not a personal signature. */
export const signatureControl = (label: string): boolean =>
  !/\bsign\s*(?:in|up|out)\b/i.test(label) &&
  /\b(signature|e[- ]?sign|sign\s+(?:this|the|document|contract|agreement|now|and|here)|sign(?:\s+\w+){0,3}\s+(?:document|contract|agreement|form|offer|declaration|consent))\b|^sign$/i.test(
    label.trim()
  );
