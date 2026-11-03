import type { LogSettings, SettingsModel } from '@nextbasejs/client';
import type { ReactNode } from 'react';
import { Code, Hint, SettingsPage, Value } from './settings-page.tsx';
import { Section, SectionRow } from './ui/section/index.ts';

const LEVELS: Record<number, string> = {
  [-4]: 'Debug',
  0: 'Info',
  4: 'Warning',
  8: 'Error',
};

export function levelName(level: number): string {
  return LEVELS[level] ?? `Level ${level}`;
}

function days(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

function recorded(on: boolean): string {
  return on ? 'Recorded' : 'Not recorded';
}

function Rows({ logs }: { logs: LogSettings }) {
  return (
    <>
      <SectionRow label="Kept for" caption={<Code>logs.maxDays</Code>}>
        <Value>{days(logs.maxDays)}</Value>
      </SectionRow>
      <SectionRow
        label="Minimum level"
        caption={
          <>
            Entries below it are not kept. <Code>logs.minLevel</Code>
          </>
        }
      >
        <Value>{levelName(logs.minLevel)}</Value>
      </SectionRow>
      <SectionRow
        label="Signed-in record"
        caption={
          <>
            The id of the record behind each request. <Code>logs.authId</Code>
          </>
        }
      >
        <Value>{recorded(logs.authId)}</Value>
      </SectionRow>
      <SectionRow
        label="Client IP"
        caption={
          <>
            Needs <Code>clientIp</Code> to know where it comes from.{' '}
            <Code>logs.ip</Code>
          </>
        }
      >
        <Value>{recorded(logs.ip)}</Value>
      </SectionRow>
    </>
  );
}

export function LogsSettings({
  settings,
  failed,
  icon,
}: {
  settings: SettingsModel | undefined;
  failed: string | undefined;
  icon: ReactNode;
}) {
  return (
    <SettingsPage title="Logs" icon={icon} failed={failed}>
      <Section title="Logs" icon={icon}>
        <Hint>
          Set with the <Code>logs</Code> option of <Code>nextbase()</Code>.
        </Hint>
        <SectionRow label="Logging">
          <Value>{settings && (settings.logs ? 'On' : 'Off')}</Value>
        </SectionRow>
        {settings?.logs && <Rows logs={settings.logs} />}
      </Section>
    </SettingsPage>
  );
}
