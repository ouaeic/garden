import { soundOn } from './settings';

let context: AudioContext | null = null;

const cues = {
  tweet: [
    [1760, 0.05],
    [2350, 0.06]
  ],
  ook: [
    [330, 0.08],
    [262, 0.1]
  ],
  bloom: [
    [523, 0.07],
    [659, 0.07],
    [784, 0.07],
    [1047, 0.14]
  ],
  attention: [
    [880, 0.08],
    [660, 0.12]
  ],
  error: [[110, 0.22]]
} as const;

/**
 * A square-wave cue, the only voice the hardware had. Silent unless the owner turned sound on,
 * and never the only signal: every cue has a visual twin.
 */
export function chirp(cue: keyof typeof cues) {
  if (!soundOn()) return;
  try {
    context ??= new AudioContext();
    let at = context.currentTime + 0.01;
    for (const [frequency, length] of cues[cue]) {
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.type = 'square';
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.04, at);
      gain.gain.setValueAtTime(0, at + length);
      tone.connect(gain).connect(context.destination);
      tone.start(at);
      tone.stop(at + length + 0.01);
      at += length + 0.015;
    }
  } catch {
    /* Audio is a nicety; a browser that refuses it loses nothing. */
  }
}
