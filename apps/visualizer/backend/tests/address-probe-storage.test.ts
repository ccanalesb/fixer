import { describe, expect, it } from 'vitest';
import { storedLiteralBaseAfterProbe } from '../src/providers/address-probe.js';

describe('storedLiteralBaseAfterProbe', () => {
  it('adds /v1 when the v1 models path answered', () => {
    expect(
      storedLiteralBaseAfterProbe('https://host', {
        answered: true,
        url: 'https://host/v1/models',
      }),
    ).toBe('https://host/v1');
  });

  it('keeps bare base when /models answered', () => {
    expect(
      storedLiteralBaseAfterProbe('https://host', {
        answered: true,
        url: 'https://host/models',
      }),
    ).toBe('https://host');
  });

  it('keeps typed value when nothing answered', () => {
    expect(
      storedLiteralBaseAfterProbe('https://host/custom', { answered: false, url: null }),
    ).toBe('https://host/custom');
  });
});
