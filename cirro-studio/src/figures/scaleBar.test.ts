import { describe, expect, it } from 'vitest';
import { scaleBar } from './scaleBar';

describe('scaleBar', () => {
  it('picks a round length near a fifth of the width', () => {
    expect(scaleBar(7258)).toEqual({ fraction: 1000 / 7258, label: '1 mm' });
    expect(scaleBar(900)).toEqual({ fraction: 100 / 900, label: '100 µm' });
    expect(scaleBar(260)).toEqual({ fraction: 50 / 260, label: '50 µm' });
  });
});
