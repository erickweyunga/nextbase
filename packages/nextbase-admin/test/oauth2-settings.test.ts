// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import type { OAuth2ProviderSettings } from '@nextbasejs/client';
import { describe, expect, it } from 'vitest';
import { profileText, providerKind } from '../src/oauth2-settings.tsx';

const provider = (
  fields: Partial<OAuth2ProviderSettings>,
): OAuth2ProviderSettings => ({
  name: 'google',
  displayName: 'Google',
  issuer: 'https://accounts.google.com',
  clientIds: ['client'],
  callbackUrl: 'https://app.example.com/api/nextbase/callback/google',
  scopes: ['openid', 'email'],
  params: {},
  disableSignUp: false,
  storeTokens: false,
  mapProfile: false,
  profileFields: null,
  photoHosts: [],
  refreshProfile: [],
  ...fields,
});

describe('OAuth2 settings text', () => {
  it('names the protocol', () => {
    expect(providerKind(provider({}))).toBe('OpenID Connect');
    expect(providerKind(provider({ issuer: '' }))).toBe("GitHub's OAuth2");
  });

  it('says where new accounts get their fields', () => {
    expect(profileText(provider({}))).toBe('Not filled from the profile');
    expect(profileText(provider({ mapProfile: true }))).toBe('From mapProfile');
    expect(
      profileText(
        provider({ profileFields: { name: 'name', avatar: 'picture' } }),
      ),
    ).toBe('name from name, avatar from picture');
    expect(
      profileText(
        provider({ profileFields: { name: 'name' }, mapProfile: true }),
      ),
    ).toBe('name from name, then mapProfile');
  });
});
