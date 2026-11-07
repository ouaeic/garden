import { describe, expect, it } from 'vitest';
import { OUTCOME_HEADLINE_CHARS, OUTCOME_ITEM_CHARS, OUTCOME_ITEMS } from '@garden/contracts';
import { bounded, outcomeHeadline, splitVerdict } from './task-outcomes.js';

describe('the closing verdict, read off a reply', () => {
  it('reads the inline form, splitting items on semicolons and middle dots', () => {
    expect(
      splitVerdict(
        'I rebuilt the page.\n\nChecked: ran pnpm test; opened it at 375px · lint is clean\nYour call: ship it today?'
      )
    ).toEqual({
      body: 'I rebuilt the page.',
      checked: ['ran pnpm test', 'opened it at 375px', 'lint is clean'],
      yourCall: ['ship it today?']
    });
  });

  it('reads bold labels with the colon on either side of the closing marker, or a dash', () => {
    for (const reply of [
      'Done.\n**Checked:** the build passes\n**Your call:** merge it',
      'Done.\n**Checked**: the build passes\n**Your call**: merge it',
      'Done.\n__Checked:__ the build passes\n*Your call*: merge it',
      'Done.\n**Checked: the build passes**\n**Your call: merge it**',
      'Done.\n> Checked — the build passes\n> Your call - merge it'
    ])
      expect(splitVerdict(reply), reply).toEqual({
        body: 'Done.',
        checked: ['the build passes'],
        yourCall: ['merge it']
      });
  });

  it('reads a label over a list, numbered or bulleted, with or without its colon', () => {
    expect(
      splitVerdict(
        'The report is ready.\n\nChecked:\n- every figure against the CSV\n* the PDF opens\n\n**Your call**\n1. publish it\n2) or hold for review'
      )
    ).toEqual({
      body: 'The report is ready.',
      checked: ['every figure against the CSV', 'the PDF opens'],
      yourCall: ['publish it', 'or hold for review']
    });
    expect(splitVerdict('Moved.\n\n### Checked\n- the redirect answers 301')).toEqual({
      body: 'Moved.',
      checked: ['the redirect answers 301'],
      yourCall: []
    });
  });

  it('reads either order, in any case, and keeps a list item that wraps onto a second line', () => {
    expect(
      splitVerdict(
        'Answer.\n\nYOUR CALL: pick a colour\nchecked:\n- the contrast ratio, which\n  passes AA'
      )
    ).toEqual({
      body: 'Answer.',
      checked: ['the contrast ratio, which passes AA'],
      yourCall: ['pick a colour']
    });
  });

  it('reads both labels on one line, and labels that close a bulleted list', () => {
    expect(splitVerdict('Fixed.\nChecked: the tests pass · Your call: deploy?')).toEqual({
      body: 'Fixed.',
      checked: ['the tests pass'],
      yourCall: ['deploy?']
    });
    expect(
      splitVerdict(
        'What changed:\n- the parser\n- its tests\n- **Checked:** ran them twice\n- **Your call:** release it'
      )
    ).toEqual({
      body: 'What changed:\n- the parser\n- its tests',
      checked: ['ran them twice'],
      yourCall: ['release it']
    });
  });

  it('takes the separator rule and blank lines above the block off with it', () => {
    expect(splitVerdict('Body line.\r\n\r\n---\r\n\r\nChecked: it runs\r\n\r\n')).toEqual({
      body: 'Body line.',
      checked: ['it runs'],
      yourCall: []
    });
  });

  it('is not a block anywhere but the end of the reply', () => {
    const middle = 'Checked: the config.\n\nThen I rebuilt the app, and it runs.';
    expect(splitVerdict(middle)).toEqual({ body: middle, checked: [], yourCall: [] });
    const trailing = 'Done.\n\nChecked: it runs\nYour call: ship it\n\nTell me if you want more.';
    expect(splitVerdict(trailing)).toEqual({ body: trailing, checked: [], yourCall: [] });
    // The word inside a sentence, or as a verb, opens nothing.
    for (const reply of [
      'I fixed it and checked: the logs are clean.',
      'Checked the deployment: it is live.',
      'All good.\n\nChecked'
    ])
      expect(splitVerdict(reply), reply).toEqual({ body: reply, checked: [], yourCall: [] });
  });

  it('keeps an earlier section of a kind already read in the answer', () => {
    expect(splitVerdict('Report.\nChecked: draft one\nChecked: draft two')).toEqual({
      body: 'Report.\nChecked: draft one',
      checked: ['draft two'],
      yourCall: []
    });
  });

  it('drops an empty section and the placeholder a model writes instead of leaving one out', () => {
    expect(splitVerdict('Done.\n\nChecked: the page loads\nYour call: none')).toEqual({
      body: 'Done.',
      checked: ['the page loads'],
      yourCall: []
    });
    expect(splitVerdict('Done.\n\nYour call:\nChecked: n/a')).toEqual({
      body: 'Done.',
      checked: [],
      yourCall: []
    });
  });

  it('bounds how many items it keeps and how long each may be', () => {
    const many = Array.from({ length: OUTCOME_ITEMS + 4 }, (_, index) => `check ${index}`);
    const long = `${'word '.repeat(OUTCOME_ITEM_CHARS)}end`;
    const verdict = splitVerdict(`Done.\nChecked: ${many.join('; ')}\nYour call: ${long}`);
    expect(verdict.checked).toEqual(many.slice(0, OUTCOME_ITEMS));
    expect(verdict.yourCall).toHaveLength(1);
    expect(verdict.yourCall[0]!.length).toBeLessThanOrEqual(OUTCOME_ITEM_CHARS);
    expect(verdict.yourCall[0]!.endsWith('…')).toBe(true);
  });

  it('stays linear on a line no model should write, because some model will', () => {
    // Two whitespace runs side by side make a pattern quadratic in the run: measured that way, twenty
    // thousand spaces after a label word took 649 ms, four times longer for every doubling. Linear,
    // these lines take a millisecond.
    const started = performance.now();
    const run = ' '.repeat(50_000);
    expect(splitVerdict(`Done.\nChecked${run}x`).checked).toEqual([]);
    expect(splitVerdict(`Done.\nChecked: a${run};${run}b`).checked).toEqual(['a', 'b']);
    expect(outcomeHeadline('**a '.repeat(50_000))).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('answers an empty reply, and a reply that is only its verdict, with an empty body', () => {
    expect(splitVerdict('')).toEqual({ body: '', checked: [], yourCall: [] });
    expect(splitVerdict('Checked: the file exists')).toEqual({
      body: '',
      checked: ['the file exists'],
      yourCall: []
    });
  });
});

describe('the headline of a reply', () => {
  it('is the first sentence of the first line with words in it, as plain text', () => {
    expect(outcomeHeadline('**Done** — I rebuilt the page. It loads in a second.')).toBe(
      'Done — I rebuilt the page.'
    );
    expect(outcomeHeadline('# Quarterly report\n\nIt is attached.')).toBe('Quarterly report');
    expect(outcomeHeadline('\n\n- Saved `report.pdf` (3.5 MB) to [the folder](x). More.')).toBe(
      'Saved report.pdf (3.5 MB) to the folder.'
    );
    expect(outcomeHeadline('```\nnpm test\n```\nThe suite passes now.')).toBe(
      'The suite passes now.'
    );
    expect(outcomeHeadline('Keeps snake_case_names, __init__.py and _emphasis_ apart')).toBe(
      'Keeps snake_case_names, __init__.py and emphasis apart'
    );
  });

  it('is cut at a word when the sentence runs long, and absent when there are no words', () => {
    const headline = outcomeHeadline(`${'Long '.repeat(OUTCOME_HEADLINE_CHARS)}sentence.`);
    expect(headline!.length).toBeLessThanOrEqual(OUTCOME_HEADLINE_CHARS);
    expect(headline!.endsWith('Long…')).toBe(true);
    expect(outcomeHeadline('')).toBeNull();
    expect(outcomeHeadline('\n---\n\n')).toBeNull();
  });
});

describe('bounding text', () => {
  it('leaves short text alone and never cuts a surrogate pair in half', () => {
    expect(bounded('short', 10)).toBe('short');
    const cut = bounded('🌱'.repeat(10), 6);
    expect(cut.length).toBeLessThanOrEqual(6);
    expect(cut).toBe('🌱🌱…');
  });
});
