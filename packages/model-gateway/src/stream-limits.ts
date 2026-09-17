/** Framing and retained metadata are bounded independently of billable model output. */
export const MAX_STREAM_LINE_CHARS = 1_000_000;
export const MAX_STREAM_METADATA_CHARS = 4_000_000;
const NO_PROGRESS_CHARS = 32_768;
// The provider-shaped one-character delta fixtures measure below this allowance.
const ENVELOPE_CHARS_PER_OUTPUT_CHAR = 512;

export function streamLimits(maxOutputChars: number) {
  let raw = 0;
  let unproductive = 0;
  let metadata = 0;
  const maximum = Math.max(NO_PROGRESS_CHARS, maxOutputChars * ENVELOPE_CHARS_PER_OUTPUT_CHAR);
  return {
    line(characters: number, progress: boolean): boolean {
      raw += characters;
      unproductive = progress ? 0 : unproductive + characters;
      return raw > maximum || unproductive > NO_PROGRESS_CHARS;
    },
    metadata(characters: number): boolean {
      metadata += characters;
      return metadata > MAX_STREAM_METADATA_CHARS;
    }
  };
}
