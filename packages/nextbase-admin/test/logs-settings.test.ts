// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import { describe, expect, it } from 'vitest';
import { levelName } from '../src/logs-settings.tsx';

describe('levelName', () => {
  it('names the standard levels and numbers the rest', () => {
    expect(levelName(-4)).toBe('Debug');
    expect(levelName(0)).toBe('Info');
    expect(levelName(4)).toBe('Warning');
    expect(levelName(8)).toBe('Error');
    expect(levelName(2)).toBe('Level 2');
  });
});
