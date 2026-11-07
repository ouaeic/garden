import { describe, expect, it } from 'vitest';
import { leadOf } from './lead';

describe('leadOf', () => {
  it('sets the claim before a dash large and the rest beneath it', () => {
    expect(
      leadOf(
        'Boiling point at 2000 m: ≈ 93 °C (366 K) — air pressure there is only ~79.5 kPa, so water boils ~7 °C lower.'
      )
    ).toEqual({
      lead: 'Boiling point at 2000 m: ≈ 93 °C (366 K)',
      dek: 'Air pressure there is only ~79.5 kPa, so water boils ~7 °C lower.'
    });
  });

  it('splits at a semicolon, and at a colon only after a full clause', () => {
    expect(
      leadOf('The heat pump is cheaper over ten years; gas wins only if prices fall by a third.')
    ).toEqual({
      lead: 'The heat pump is cheaper over ten years',
      dek: 'Gas wins only if prices fall by a third.'
    });
    expect(
      leadOf('The cheapest option is the heat pump: €8,900 over ten years against €11,200 for gas.')
        .lead
    ).toBe('The cheapest option is the heat pump');
    // A label before a colon is part of the claim, not a clause of its own.
    expect(
      leadOf('Result: the suite passes on every platform we build for, including the phone.')
    ).toEqual({
      lead: 'Result: the suite passes on every platform we build for, including the phone.',
      dek: null
    });
  });

  it('leaves a short or unbroken line whole', () => {
    expect(leadOf('Done — I rebuilt the page.')).toEqual({
      lead: 'Done — I rebuilt the page.',
      dek: null
    });
    const unbroken =
      'The quarterly numbers are attached as a spreadsheet with one sheet for each region and a summary';
    expect(leadOf(unbroken)).toEqual({ lead: unbroken, dek: null });
  });
});
