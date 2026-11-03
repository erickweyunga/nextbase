// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import { describe, expect, it } from 'vitest';
import {
  clientIpText,
  realtimeText,
  ruleText,
  timeoutText,
} from '../src/application-settings.tsx';

describe('application settings text', () => {
  it("names where the client's IP comes from", () => {
    expect(clientIpText({ source: 'unknown' })).toBe('Unknown');
    expect(clientIpText({ source: 'vercel' })).toBe("Vercel's headers");
    expect(clientIpText({ source: 'function' })).toBe('A function of yours');
    expect(
      clientIpText({ source: 'header', header: 'x-real-ip', trustedHops: 0 }),
    ).toBe('The x-real-ip header');
    expect(
      clientIpText({
        source: 'header',
        header: 'x-forwarded-for',
        trustedHops: 2,
      }),
    ).toBe('The x-forwarded-for header, 2 proxies back');
  });

  it('reads a rate limit rule as a sentence', () => {
    expect(
      ruleText({ label: '*:auth', audience: null, max: 2, window: 3 }),
    ).toBe('2 requests per 3 seconds, everyone');
    expect(ruleText({ label: '/', audience: 'guest', max: 1, window: 1 })).toBe(
      '1 request per 1 second, guests',
    );
  });

  it('reads the statement timeout and realtime', () => {
    expect(timeoutText(0)).toBe('No limit');
    expect(timeoutText(8000)).toBe('8 seconds');
    expect(timeoutText(1500)).toBe('1500 ms');
    expect(realtimeText(null)).toBe('Off');
    expect(realtimeText({ collections: null, streamSeconds: 240 })).toBe(
      'Every collection',
    );
    expect(realtimeText({ collections: ['posts'], streamSeconds: 240 })).toBe(
      '1 collection',
    );
  });
});
