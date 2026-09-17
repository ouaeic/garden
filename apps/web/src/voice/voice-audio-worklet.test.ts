import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioControl, AudioObservation } from './audio-types';
import { pcm16 } from './audio-dsp';
import { VOICE_PLAYBACK_BUFFER_SECONDS } from './audio-constants';

type Processor = {
  port: Port;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};
class Port {
  onmessage: ((event: { data: AudioControl }) => void) | null = null;
  messages: AudioObservation[] = [];
  postMessage(message: AudioObservation) {
    this.messages.push(message);
  }
  send(data: AudioControl) {
    this.onmessage?.({ data });
  }
}
async function processor(rate = 48000) {
  let constructor: (new () => Processor) | undefined;
  vi.stubGlobal('sampleRate', rate);
  vi.stubGlobal('currentTime', 0);
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      port = new Port();
    }
  );
  vi.stubGlobal('registerProcessor', (_name: string, value: new () => Processor) => {
    constructor = value;
  });
  vi.resetModules();
  await import('./voice-audio-worklet');
  expect(constructor).toBeDefined();
  return new constructor!();
}
afterEach(() => vi.unstubAllGlobals());

describe('voice worklet ownership', () => {
  it('does not capture before readiness or while muted, and restarts sample offsets only for a new epoch', async () => {
    const node = await processor();
    const mic = [[new Float32Array(128).fill(0.1)]];
    const speaker = [[new Float32Array(128)]];
    for (let i = 0; i < 20; i++) node.process(mic, speaker);
    expect(node.port.messages.filter((message) => message.type === 'capture')).toEqual([]);
    node.port.send({ type: 'input', epoch: 2, enabled: true });
    for (let i = 0; i < 20; i++) node.process(mic, speaker);
    const captured = node.port.messages.filter((message) => message.type === 'capture');
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toMatchObject({ epoch: 2, offset: 0 });
    node.port.send({ type: 'input', epoch: 2, enabled: false });
    for (let i = 0; i < 20; i++) node.process(mic, speaker);
    expect(node.port.messages.filter((message) => message.type === 'capture')).toHaveLength(
      captured.length
    );
    node.port.send({ type: 'input', epoch: 3, enabled: true });
    for (let i = 0; i < 10; i++) node.process(mic, speaker);
    expect(node.port.messages.filter((message) => message.type === 'capture').at(-1)).toMatchObject(
      { epoch: 3, offset: 0 }
    );
  });

  it('reports rendered samples rather than received samples and flushes an interrupted epoch', async () => {
    const node = await processor();
    node.port.send({ type: 'output', epoch: 4 });
    node.port.send({
      type: 'pcm',
      epoch: 4,
      offset: 0,
      pcm: pcm16(new Float32Array(2400).fill(0.25))
    });
    expect(node.port.messages.filter((message) => message.type === 'played')).toEqual([]);
    vi.stubGlobal('currentTime', 0.1);
    const out = new Float32Array(128);
    node.process([], [[out]]);
    expect(out.some((sample) => sample > 0.1)).toBe(true);
    const progress = node.port.messages.find((message) => message.type === 'played');
    expect(progress).toMatchObject({ epoch: 4, samples: 64 });
    node.port.send({ type: 'flush', epoch: 4 });
    const silent = new Float32Array(128);
    node.process([], [[silent]]);
    expect(silent.every((sample) => sample === 0)).toBe(true);
    node.port.send({
      type: 'pcm',
      epoch: 4,
      offset: 2400,
      pcm: pcm16(new Float32Array(2400).fill(0.25))
    });
    node.process([], [[silent]]);
    expect(silent.every((sample) => sample === 0)).toBe(true);
  });

  it('ends on discontinuous or oversized queued playback rather than accumulating audio', async () => {
    const node = await processor();
    node.port.send({ type: 'output', epoch: 1 });
    node.port.send({ type: 'pcm', epoch: 1, offset: 1, pcm: new ArrayBuffer(4800) });
    expect(node.port.messages.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('out of order') as unknown
    });
    expect(node.process([], [[new Float32Array(128)]])).toBe(false);
    const bounded = await processor();
    bounded.port.send({ type: 'output', epoch: 2 });
    for (let offset = 0; offset < (VOICE_PLAYBACK_BUFFER_SECONDS + 1) * 24000; offset += 2400)
      bounded.port.send({ type: 'pcm', epoch: 2, offset, pcm: new ArrayBuffer(4800) });
    expect(bounded.port.messages.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('fell behind') as unknown
    });
  });

  it('bounds the microphone message backlog and releases processing on stop', async () => {
    const node = await processor();
    node.port.send({ type: 'input', epoch: 1, enabled: true });
    for (let i = 0; i < 120; i++)
      node.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
    expect(node.port.messages.filter((message) => message.type === 'capture')).toHaveLength(10);
    expect(node.port.messages.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('keep up') as unknown
    });
    const stopped = await processor();
    stopped.port.send({ type: 'stop' });
    expect(stopped.process([], [[new Float32Array(128)]])).toBe(false);
  });
});
