// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import type { SecuritySettings } from '@nextbasejs/client';
import { describe, expect, it } from 'vitest';
import { secretKeysText } from '../src/security-settings.tsx';

const security = (fields: Partial<SecuritySettings>): SecuritySettings => ({
  secretKeys: 0,
  secretKeySource: 'none',
  rejectBreachedPasswords: false,
  validateSignIn: false,
  ...fields,
});

describe('secretKeysText', () => {
  it('says how many keys there are and where they come from', () => {
    expect(secretKeysText(security({}))).toBe('Not set');
    expect(
      secretKeysText(security({ secretKeys: 1, secretKeySource: 'env' })),
    ).toBe('1 key, from NEXTBASE_SECRET_KEY');
    expect(
      secretKeysText(security({ secretKeys: 2, secretKeySource: 'option' })),
    ).toBe('2 keys, from the secretKey option');
  });
});
