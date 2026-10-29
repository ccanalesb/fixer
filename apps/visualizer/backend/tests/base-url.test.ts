import { describe, expect, it } from 'vitest';
import {
  normalizeBaseUrlInput,
  providerAddressesEquivalent,
  providerHostKey,
} from '../src/providers/base-url.js';

describe('normalizeBaseUrlInput', () => {
  it('trims chat completion paths', () => {
    expect(normalizeBaseUrlInput('https://host/v1/chat/completions')).toBe('https://host/v1');
    expect(normalizeBaseUrlInput('https://host/chat/completions')).toBe('https://host');
    expect(normalizeBaseUrlInput('https://host/v1/messages')).toBe('https://host/v1');
  });
});

describe('providerAddressesEquivalent', () => {
  it('treats trailing slashes and optional /v1 as the same address', () => {
    expect(providerAddressesEquivalent('https://host', 'https://host/')).toBe(true);
    expect(providerAddressesEquivalent('https://host', 'https://host/v1')).toBe(true);
    expect(providerAddressesEquivalent('https://host/v1/', 'https://host')).toBe(true);
  });

  it('sees port changes as different addresses', () => {
    expect(providerAddressesEquivalent('https://host:8000', 'https://host:9000')).toBe(false);
  });
});

describe('providerHostKey', () => {
  it('ignores port for host identity', () => {
    expect(providerHostKey('https://a.example:8000')).toBe('a.example');
    expect(providerHostKey('https://a.example:9000')).toBe('a.example');
  });

  it('sees different hostnames', () => {
    expect(providerHostKey('https://a.example')).not.toBe(providerHostKey('https://b.example'));
  });
});
