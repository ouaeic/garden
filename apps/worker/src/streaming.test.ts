import { describe, expect, it } from 'vitest';
import {
  boundedToolResultForModel,
  createStreamFlusher,
  degenerateRepeat,
  normalizeAssistantText
} from './streaming.js';
import {
  IDLE_STEPS_BEFORE_STOP,
  MAX_IDLE_STEPS,
  idleStepBreak,
  idleStepsAfter
} from './turn-bounds.js';
import { previewUrl } from './values.js';

describe('agent chat output', () => {
  it('suppresses whitespace-only assistant turns', () => {
    expect(normalizeAssistantText('\n\n')).toBe('');
  });

  it('removes a provider routing marker from the start of chat text', () => {
    expect(normalizeAssistantText(' into chatLet me inspect the workspace.')).toBe(
      'Let me inspect the workspace.'
    );
  });

  it('points a preview link at the page rather than at a file index', () => {
    /*
     * The owner asked for a page and a link. The agent started a file server on the workspace and
     * published its port, so the link opened on an index of every file in there while the page it
     * had just written sat one path away. Saying so in the tool description was tried first and the
     * model went on serving the workspace root, so the address itself carries the answer now.
     */
    const base = 'https://box.example/__garden/preview';
    expect(previewUrl(base, 'abc', undefined, 'inspire.html')).toBe(
      'https://box.example/__garden/preview/abc/inspire.html'
    );
    // A leading slash is the owner's, not a second root.
    expect(previewUrl(base, 'abc', undefined, '/inspire.html')).toBe(
      'https://box.example/__garden/preview/abc/inspire.html'
    );
    // An app that serves its own root keeps the address it always had, token and all.
    expect(previewUrl(base, 'abc', 'tok')).toBe(
      'https://box.example/__garden/preview/abc/?access=tok'
    );
    expect(previewUrl(base, 'abc', 'tok', 'app/index.html')).toBe(
      'https://box.example/__garden/preview/abc/app/index.html?access=tok'
    );
  });

  it('spots a model that has stopped writing and started looping', () => {
    // The observed case, verbatim: seventeen thousand output tokens of one sentence, ended only by
    // the provider's 900-second ceiling.
    const looped = 'The user is not watching the screen right now. '.repeat(40);
    expect(degenerateRepeat(looped)).toContain('not watching the screen');
    // Answered, then looped: the tail is what matters, not the whole answer.
    expect(degenerateRepeat(`Here is the real answer.\n\n${looped}`)).toBeTruthy();
  });

  it('leaves prose, tables and code alone', () => {
    expect(degenerateRepeat('A perfectly ordinary paragraph that says a thing once.')).toBe('');
    expect(
      degenerateRepeat(
        ['| host | port |', '| a.example | 80 |', '| b.example | 443 |', '| c.example | 8080 |']
          .join('\n')
          .repeat(2)
      )
    ).toBe('');
    // A loop body whose lines differ is not a loop in the output.
    const code = Array.from({ length: 30 }, (_, i) => `  console.log('step ${i}');`).join('\n');
    expect(degenerateRepeat(code)).toBe('');
    // Short repeats are somebody writing, not a model looping.
    expect(degenerateRepeat('ha '.repeat(30))).toBe('');
  });

  it('counts steps that started no tool, and only those', () => {
    // The measured shape: the same read asked for again and again, answered from the first one, so
    // nothing runs and nothing is learned. Three steps of it and no more.
    const asked = { proposed: ['file_read'], started: 0 };
    expect(idleStepsAfter(0, asked)).toBe(1);
    expect(idleStepsAfter(1, asked)).toBe(2);
    expect(idleStepsAfter(MAX_IDLE_STEPS - 1, asked)).toBe(MAX_IDLE_STEPS);
    // One tool starting anywhere in the step is the whole reset. This is what makes a turn that
    // thinks for ten steps while still moving invisible to the guard.
    expect(idleStepsAfter(2, { proposed: ['file_read', 'shell'], started: 1 })).toBe(0);
    expect(idleStepsAfter(2, { proposed: ['file_read', 'finish'], started: 1 })).toBe(0);
  });

  it('leaves the count alone for the tools the loop answers itself', () => {
    // Each of these has its own bound, and two bounds counting the same step race each other: a
    // third rejected finish would otherwise trip this as well as MAX_FINISH_REJECTIONS.
    for (const name of ['finish', 'compact_context', 'notify', 'ask', 'set_acceptance'])
      expect(idleStepsAfter(2, { proposed: [name], started: 0 })).toBeUndefined();
    /*
     * A reply with no tool call at all is the completion nag's, which ends the turn by completing
     * it rather than by pushing back - and the loop must agree with this function about that. It
     * did not: the no-tool-call branch raised the count itself, so two steps of ordinary reasoning
     * plus one read answered from an earlier one reached the break, and the turn was told "NOTHING
     * HAS RUN FOR 3 STEPS" when one step had. Pinned end to end by
     * `small-reasoning-between-commands-is-not-called-a-stall`.
     */
    expect(idleStepsAfter(2, { proposed: [], started: 0 })).toBeUndefined();
    // Mixed: the dispatchable call is what is being judged, and it started nothing.
    expect(idleStepsAfter(2, { proposed: ['finish', 'file_read'], started: 0 })).toBe(3);
  });

  it('tells the model the number and the two ways out of it', () => {
    const said = idleStepBreak(MAX_IDLE_STEPS);
    expect(said).toContain(`${MAX_IDLE_STEPS} STEPS`);
    // Both exits, named: act differently, or stop and say what is in the way.
    expect(said).toContain('take the next concrete action');
    expect(said).toContain('finish');
  });

  it('says it three times before it ends anything', () => {
    // The stop is the half that costs the owner a turn, so it may never be the first thing the
    // model hears. Every step from MAX_IDLE_STEPS up to the stop pushes back with the count risen.
    expect(IDLE_STEPS_BEFORE_STOP).toBeGreaterThan(MAX_IDLE_STEPS);
    const told: number[] = [];
    for (let steps = MAX_IDLE_STEPS; steps < IDLE_STEPS_BEFORE_STOP; steps += 1) told.push(steps);
    expect(told).toHaveLength(3);
    expect(told.map((steps) => idleStepBreak(steps).includes(`${steps} STEPS`))).toEqual([
      true,
      true,
      true
    ]);
  });

  it('drops the control tokens a model opens its own turn with', () => {
    // A completion cut off at the output limit is continued, and the model starts the next piece
    // the way it starts any turn. The owner's transcript carried a correct, cited answer about a
    // news front page that began with the opener, four times over.
    expect(
      normalizeAssistantText('<\uFF5Cbegin\u2581of\u2581sentence\uFF5C>The top story is X.')
    ).toBe('The top story is X.');
    expect(normalizeAssistantText('Done.<|im_end|>')).toBe('Done.');
    // Prose and code keep their pipes.
    expect(normalizeAssistantText('Use `a <| b` and the table | column | here.')).toBe(
      'Use `a <| b` and the table | column | here.'
    );
  });

  it('suppresses leaked internal plan fragments', () => {
    expect(normalizeAssistantText('4. [pending] Finish with a concise summary')).toBe('');
  });

  it('preserves ordinary assistant text', () => {
    expect(normalizeAssistantText('  All outputs are ready.  ')).toBe('All outputs are ready.');
  });
});

describe('tool results sent to the model', () => {
  it('replaces image bytes with a reference so base64 never enters the window', () => {
    expect(
      boundedToolResultForModel(
        'image_read',
        { base64: 'A'.repeat(20_000) },
        {
          mimeType: 'image/png',
          bytes: 1_024,
          path: 'workspace/shot.png'
        }
      )
    ).toEqual({
      mimeType: 'image/png',
      bytes: 1_024,
      path: 'workspace/shot.png',
      image: '[attached to this conversation for inspection]'
    });
  });

  it('strips screenshots from snapshots while keeping the actionable fields', () => {
    expect(
      boundedToolResultForModel('browser_snapshot', {
        url: 'https://example.invalid',
        elements: [{ selector: 'a' }],
        screenshotBase64: 'A'.repeat(20_000)
      })
    ).toEqual({
      url: 'https://example.invalid',
      elements: [{ selector: 'a' }],
      screenshotBase64: '[screenshot available in timeline]'
    });
  });

  it('passes an ordinary tool result through unchanged', () => {
    expect(boundedToolResultForModel('shell', { stdout: 'ok' })).toEqual({ stdout: 'ok' });
  });
});

describe('streaming a reply into the timeline', () => {
  /** Streams `text` in `chunk`-sized pieces spread evenly over `totalMs` of wall clock. */
  const drive = (text: string, chunk: number, totalMs: number) => {
    let clock = 0;
    const flusher = createStreamFlusher(250, () => clock);
    const frames: string[] = [];
    const step = totalMs / Math.ceil(text.length / chunk);
    for (let at = 0; at < text.length; at += chunk) {
      clock += step;
      const frame = flusher.push(text.slice(at, at + chunk));
      if (frame !== null) frames.push(frame);
    }
    const tail = flusher.drain();
    if (tail !== null) frames.push(tail);
    return frames;
  };

  it('writes each frame once instead of repeating the whole reply so far', () => {
    // Every frame is its own encrypted, row-locked event. Repeating the answer so far made the
    // bytes written quadratic: a 64,000-character reply wrote 12.77 MB across 400 rows.
    const reply = 'y'.repeat(64_000);
    const frames = drive(reply, 40, 120_000);

    expect(frames.join('')).toBe(reply);
    const written = frames.reduce((total, frame) => total + frame.length, 0);
    expect(written).toBe(reply.length);
    const cumulative = (reply.length / 160) * ((reply.length + 160) / 2);
    expect(written).toBeLessThan(cumulative / 100);
  });

  it('emits the opening frame at once and then holds to the flush interval', () => {
    let clock = 0;
    const flusher = createStreamFlusher(250, () => clock);
    expect(flusher.push('Checking')).toBe('Checking');
    clock += 100;
    expect(flusher.push(' the workspace')).toBeNull();
    clock += 100;
    expect(flusher.push(' for the unit')).toBeNull();
    clock += 100;
    // 300 ms since the first frame, so the text buffered across both ticks goes out together.
    expect(flusher.push(' file.')).toBe(' the workspace for the unit file.');
    expect(flusher.drain()).toBeNull();
  });

  it('does not write a row for a route that has produced almost nothing', () => {
    let clock = 0;
    const flusher = createStreamFlusher(250, () => clock);
    flusher.push('Working');
    for (let tick = 0; tick < 6; tick += 1) {
      clock += 300;
      expect(flusher.push('.')).toBeNull();
    }
    // Held back while it was a handful of characters, but never lost.
    expect(flusher.drain()).toBe('......');
  });

  it('bounds writes by elapsed time rather than by how much text arrives', () => {
    // Two routes talking for the same half minute cost the same number of rows, whether they
    // produced four thousand characters or sixty-four thousand.
    const short = drive('z'.repeat(4_000), 20, 30_000).length;
    const long = drive('z'.repeat(64_000), 20, 30_000).length;
    const ceiling = 30_000 / 250 + 1;
    expect(short).toBeLessThanOrEqual(ceiling);
    expect(long).toBeLessThanOrEqual(ceiling);
    expect(long / short).toBeLessThan(1.5);
    // The character rule this replaced wrote one row per 160 characters: 400 for the long reply.
    expect(long).toBeLessThan(64_000 / 160);
  });

  it('drains the last partial frame so the reply is never left cut short', () => {
    let clock = 0;
    const flusher = createStreamFlusher(250, () => clock);
    flusher.push('done');
    clock += 10;
    flusher.push(' and dusted');
    expect(flusher.drain()).toBe(' and dusted');
    expect(flusher.drain()).toBeNull();
  });
});
