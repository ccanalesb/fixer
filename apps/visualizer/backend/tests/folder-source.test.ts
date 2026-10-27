import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { isFolderSourceInput } from '../src/app-models/folder-source.js';
import { parseModelSource } from '../src/app-models/install.js';

describe('isFolderSourceInput', () => {
  it.each([
    '/models/best',
    '~/checkpoints',
    './local',
    'C:\\Users\\me\\model',
    'D:/training/run-1',
    '\\\\nas\\share\\models',
    '//nas/share/models',
  ])('treats %s as a folder path', (input) => {
    expect(isFolderSourceInput(input)).toBe(true);
  });

  it.each(['owner/repo', 'owner/repo@rev', 'vision', ''])('does not treat %s as a folder path', (input) => {
    expect(isFolderSourceInput(input)).toBe(false);
  });
});

describe('parseModelSource with Windows-shaped paths', () => {
  it('resolves a drive-letter folder when the path module and fs say it exists', () => {
    const folder = 'C:\\Models\\best';
    const result = parseModelSource(folder, {
      path: path.win32,
      expandUserPath: (p) => p,
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
    });
    expect(result).toEqual({ kind: 'folder', source: path.win32.resolve(folder) });
  });

  it('resolves a UNC folder when the path module and fs say it exists', () => {
    const folder = '\\\\fileserver\\weights\\v1';
    const result = parseModelSource(folder, {
      path: path.win32,
      expandUserPath: (p) => p,
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
    });
    expect(result).toEqual({ kind: 'folder', source: path.win32.resolve(folder) });
  });
});
