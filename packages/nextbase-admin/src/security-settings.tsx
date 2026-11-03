import type { SecuritySettings, SettingsModel } from '@nextbasejs/client';
import type { ReactNode } from 'react';
import { Code, Hint, SettingsPage, Value } from './settings-page.tsx';
import { Section, SectionRow } from './ui/section/index.ts';

export function secretKeysText(security: SecuritySettings): string {
  if (security.secretKeySource === 'none') return 'Not set';
  const keys =
    security.secretKeys === 1 ? '1 key' : `${security.secretKeys} keys`;
  return security.secretKeySource === 'env'
    ? `${keys}, from NEXTBASE_SECRET_KEY`
    : `${keys}, from the secretKey option`;
}

export function SecuritySettingsPage({
  settings,
  failed,
  icon,
}: {
  settings: SettingsModel | undefined;
  failed: string | undefined;
  icon: ReactNode;
}) {
  const security = settings?.security;
  return (
    <SettingsPage title="Security" icon={icon} failed={failed}>
      <Section title="Security" icon={icon}>
        <Hint>
          Set with the options of <Code>nextbase()</Code>. Sessions, MFA and
          passkeys are set per auth collection.
        </Hint>
        <SectionRow
          label="Secret keys"
          caption={
            security?.secretKeySource === 'none' ? (
              <>
                Authenticator apps and stored OAuth2 tokens need one.{' '}
                <Code>secretKey</Code>
              </>
            ) : (
              <>
                Encrypt authenticator app secrets and stored OAuth2 tokens. The
                first encrypts, all decrypt. The keys are never shown.
              </>
            )
          }
        >
          <Value>{security && secretKeysText(security)}</Value>
        </SectionRow>
        <SectionRow
          label="Breached passwords"
          caption={
            <>
              Checked with Have I Been Pwned, sending only a 5-character hash
              prefix. <Code>rejectBreachedPasswords</Code>
            </>
          }
        >
          <Value>
            {security &&
              (security.rejectBreachedPasswords ? 'Refused' : 'Not checked')}
          </Value>
        </SectionRow>
        <SectionRow
          label="Sign-in check"
          caption={
            <>
              Your function, run at every sign-up, link and sign-in.{' '}
              <Code>validateSignIn</Code>
            </>
          }
        >
          <Value>{security && (security.validateSignIn ? 'On' : 'None')}</Value>
        </SectionRow>
      </Section>
    </SettingsPage>
  );
}
