import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { isResolvedPathInsideDir } from '../src/utils/path-containment.js';

describe('isResolvedPathInsideDir', () => {
  describe('POSIX paths', () => {
    const posix = path.posix;
    const base = '/app/resources/prompts/perspectives';

    it('allows the base directory itself', () => {
      expect(isResolvedPathInsideDir(base, base, posix)).toBe(true);
    });

    it('allows a file under the base', () => {
      expect(isResolvedPathInsideDir(base, `${base}/landscape.md`, posix)).toBe(true);
    });

    it('rejects a sibling path', () => {
      expect(isResolvedPathInsideDir(base, '/app/resources/prompts/other.md', posix)).toBe(false);
    });

    it('rejects .. escape after join+resolve', () => {
      expect(isResolvedPathInsideDir(base, posix.resolve(base, '../../../etc/passwd'), posix)).toBe(false);
    });
  });

  describe('Windows paths', () => {
    const win32 = path.win32;
    const base = 'C:\\Fixer\\resources\\prompts\\perspectives';

    it('allows a file under the base with backslashes', () => {
      expect(isResolvedPathInsideDir(base, `${base}\\landscape.md`, win32)).toBe(true);
    });

    it('allows a file under the base with forward slashes', () => {
      expect(isResolvedPathInsideDir(base, 'C:/Fixer/resources/prompts/perspectives/portrait.md', win32)).toBe(true);
    });

    it('rejects a path outside the base on the same drive', () => {
      expect(isResolvedPathInsideDir(base, 'C:\\Fixer\\other\\evil.md', win32)).toBe(false);
    });

    it('rejects .. escape', () => {
      expect(isResolvedPathInsideDir(base, win32.resolve(base, '..\\..\\Windows\\System32\\cmd.exe'), win32)).toBe(
        false,
      );
    });
  });
});
