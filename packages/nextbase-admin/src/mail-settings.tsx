import type {
  MailEmail,
  MailSettings,
  SettingsModel,
} from '@nextbasejs/client';
import type { ReactNode } from 'react';
import { FILLER_COLUMN, NOWRAP_COLUMN } from './components/grid-columns.ts';
import {
  Code,
  Hint,
  SettingsPage,
  Value,
  ValueCode,
} from './settings-page.tsx';
import { Section, SectionRow } from './ui/section/index.ts';
import {
  columnOverrides,
  DIVIDER,
  TableBuilder,
  TableBuilderColumn,
} from './ui/table/index.ts';

const SUBJECT_COLUMN = columnOverrides({ width: '280px', nowrap: true });

const DELIVERY: Record<MailSettings['delivery'], string> = {
  send: 'Sent with mail.send',
  log: 'Written to the server log',
  off: 'Not set up, so refused',
};

const DELIVERY_CAPTION: Record<MailSettings['delivery'], string> = {
  send: 'Through the provider your send function calls.',
  log: 'Development without the mail option logs emails, so sign-in flows work locally.',
  off: 'Production without the mail option answers 400 where an email is needed.',
};

export function linkSite(mail: MailSettings | undefined): string {
  const link = mail?.emails.find((email) => email.link)?.link;
  return link ? new URL(link).origin : '';
}

export function MailSettingsPage({
  settings,
  failed,
  icon,
}: {
  settings: SettingsModel | undefined;
  failed: string | undefined;
  icon: ReactNode;
}) {
  const mail = settings?.mail;
  const site = linkSite(mail);
  return (
    <SettingsPage title="Mail" icon={icon} failed={failed}>
      <Section title="Mail" icon={icon}>
        <Hint>
          Set with the <Code>mail</Code> option of <Code>nextbase()</Code>.
        </Hint>
        <SectionRow
          label="Delivery"
          caption={mail && DELIVERY_CAPTION[mail.delivery]}
        >
          <Value>{mail && DELIVERY[mail.delivery]}</Value>
        </SectionRow>
        {site && (
          <SectionRow
            label="Links open on"
            caption={
              <>
                Each page gets a <Code>?token=</Code>. <Code>mail.appUrl</Code>{' '}
                or <Code>appUrl</Code>
              </>
            }
          >
            <ValueCode>{site}</ValueCode>
          </SectionRow>
        )}
        {mail?.from && (
          <SectionRow label="From" caption={<Code>mail.from</Code>}>
            <ValueCode>{mail.from}</ValueCode>
          </SectionRow>
        )}
      </Section>
      <TableBuilder
        data={mail?.emails ?? []}
        framed
        divider={DIVIDER.grid}
        pageSize={Number.MAX_SAFE_INTEGER}
        isLoading={mail === undefined}
      >
        <TableBuilderColumn<MailEmail>
          header="Email"
          overrides={SUBJECT_COLUMN}
        >
          {(email) => email.subject}
        </TableBuilderColumn>
        <TableBuilderColumn<MailEmail>
          header="Template"
          overrides={NOWRAP_COLUMN}
        >
          {(email) => (email.custom ? 'Custom' : 'Default')}
        </TableBuilderColumn>
        <TableBuilderColumn<MailEmail> header="Key" overrides={NOWRAP_COLUMN}>
          {(email) => <Code>{email.kind}</Code>}
        </TableBuilderColumn>
        <TableBuilderColumn<MailEmail>
          header="Link opens"
          overrides={NOWRAP_COLUMN}
        >
          {(email) => email.link && <Code>{new URL(email.link).pathname}</Code>}
        </TableBuilderColumn>
        <TableBuilderColumn<MailEmail> header="" overrides={FILLER_COLUMN}>
          {() => null}
        </TableBuilderColumn>
      </TableBuilder>
    </SettingsPage>
  );
}
