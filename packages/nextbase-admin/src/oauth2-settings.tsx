import type { OAuth2ProviderSettings, SettingsModel } from '@nextbasejs/client';
import type { ReactNode } from 'react';
import {
  Code,
  Codes,
  Hint,
  SettingsPage,
  Value,
  ValueCode,
} from './settings-page.tsx';
import { Button, KIND, SHAPE, SIZE } from './ui/button/index.ts';
import { EmptyState } from './ui/empty-state/index.ts';
import { ContentCopyIcon } from './ui/icons/index.tsx';
import { Section, SectionRow } from './ui/section/index.ts';
import { styled } from './ui/styles/index.ts';
import { toaster } from './ui/toast/index.ts';

const Copyable = styled('span', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
  minWidth: 0,
}));

export function providerKind(provider: OAuth2ProviderSettings): string {
  return provider.issuer === '' ? "GitHub's OAuth2" : 'OpenID Connect';
}

export function profileText(provider: OAuth2ProviderSettings): string {
  const fields = provider.profileFields
    ? Object.entries(provider.profileFields).map(
        ([field, claim]) => `${field} from ${claim}`,
      )
    : [];
  if (provider.mapProfile) {
    return fields.length > 0
      ? `${fields.join(', ')}, then mapProfile`
      : 'From mapProfile';
  }
  return fields.length > 0 ? fields.join(', ') : 'Not filled from the profile';
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toaster.positive('Copied the callback URL.', { key: 'oauth2' });
  } catch {
    toaster.negative('Failed to copy the callback URL.', { key: 'oauth2' });
  }
}

function Provider({
  provider,
  icon,
}: {
  provider: OAuth2ProviderSettings;
  icon: ReactNode;
}) {
  const params = Object.entries(provider.params).map(
    ([key, value]) => `${key}=${value}`,
  );
  return (
    <Section title={provider.displayName} icon={icon}>
      <SectionRow
        label="Name"
        caption="Its key in the oauth2 option, and in URLs."
      >
        <ValueCode>{provider.name}</ValueCode>
      </SectionRow>
      <SectionRow label="Protocol">
        {provider.issuer ? (
          <Copyable>
            <Value>{providerKind(provider)},</Value>
            <ValueCode>{provider.issuer}</ValueCode>
          </Copyable>
        ) : (
          <Value>{providerKind(provider)}</Value>
        )}
      </SectionRow>
      <SectionRow
        label="Callback URL"
        caption="Register it as the redirect URI in the provider's app."
      >
        <Copyable>
          <ValueCode>{provider.callbackUrl}</ValueCode>
          <Button
            type="button"
            kind={KIND.tertiary}
            shape={SHAPE.square}
            size={SIZE.mini}
            aria-label={`Copy the callback URL of ${provider.displayName}`}
            onClick={() => void copy(provider.callbackUrl)}
          >
            <ContentCopyIcon size={16} />
          </Button>
        </Copyable>
      </SectionRow>
      <SectionRow
        label={provider.clientIds.length === 1 ? 'Client ID' : 'Client IDs'}
        caption={
          provider.clientIds.length > 1
            ? 'Browser sign-ins use the first; ID tokens may be issued to any.'
            : 'The client secret is never shown.'
        }
      >
        <Codes items={provider.clientIds} />
      </SectionRow>
      <SectionRow label="Scopes">
        <ValueCode>{provider.scopes.join(' ')}</ValueCode>
      </SectionRow>
      {params.length > 0 && (
        <SectionRow
          label="Parameters"
          caption="Added to the provider's sign-in page."
        >
          <Codes items={params} />
        </SectionRow>
      )}
      <SectionRow label="Sign-up" caption={<Code>disableSignUp</Code>}>
        <Value>
          {provider.disableSignUp
            ? 'Existing accounts only'
            : 'Creates accounts'}
        </Value>
      </SectionRow>
      <SectionRow
        label="New accounts"
        caption={
          <>
            <Code>profileFields</Code>, <Code>mapProfile</Code>
          </>
        }
      >
        <Value>{profileText(provider)}</Value>
      </SectionRow>
      {provider.refreshProfile.length > 0 && (
        <SectionRow
          label="Refreshed"
          caption={
            <>
              At every sign-in. <Code>refreshProfile</Code>
            </>
          }
        >
          <ValueCode>{provider.refreshProfile.join(', ')}</ValueCode>
        </SectionRow>
      )}
      {provider.photoHosts.length > 0 && (
        <SectionRow label="Photos from" caption={<Code>photoHosts</Code>}>
          <Codes items={provider.photoHosts} />
        </SectionRow>
      )}
      <SectionRow
        label="Tokens"
        caption={
          <>
            For <Code>getAccessToken</Code>. <Code>storeTokens</Code>
          </>
        }
      >
        <Value>{provider.storeTokens ? 'Kept, encrypted' : 'Not kept'}</Value>
      </SectionRow>
    </Section>
  );
}

export function OAuth2SettingsPage({
  settings,
  failed,
  icon,
}: {
  settings: SettingsModel | undefined;
  failed: string | undefined;
  icon: ReactNode;
}) {
  const providers = settings?.oauth2;
  return (
    <SettingsPage title="OAuth2 providers" icon={icon} failed={failed}>
      <Hint>
        Set with the <Code>oauth2</Code> option of <Code>nextbase()</Code>.
      </Hint>
      {providers?.length === 0 && (
        <EmptyState icon={icon} title="No OAuth2 providers" />
      )}
      {providers?.map((provider) => (
        <Provider key={provider.name} provider={provider} icon={icon} />
      ))}
    </SettingsPage>
  );
}
