// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import type { MailSettings } from '@nextbasejs/client';
import { describe, expect, it } from 'vitest';
import { linkSite } from '../src/mail-settings.tsx';

const mail = (links: string[]): MailSettings => ({
  delivery: 'send',
  from: 'app@example.com',
  emails: links.map((link, i) => ({
    kind: `kind${i}`,
    subject: 'Subject',
    custom: false,
    link,
  })),
});

describe('linkSite', () => {
  it('is the origin email links open on, or empty without links', () => {
    expect(linkSite(mail(['', 'https://app.example.com/a/verify-email']))).toBe(
      'https://app.example.com',
    );
    expect(linkSite(mail(['', '']))).toBe('');
    expect(linkSite(undefined)).toBe('');
  });
});
