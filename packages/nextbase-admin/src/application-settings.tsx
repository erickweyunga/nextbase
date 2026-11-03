import type {
  ApplicationSettings,
  ClientIpSettings,
  RateLimitRuleSettings,
  SettingsModel,
} from '@nextbasejs/client';
import { expandBorderStyles } from 'baseui/styles';
import type { ReactNode } from 'react';
import {
  Code,
  Codes,
  Hint,
  SettingsPage,
  Value,
  ValueCode,
} from './settings-page.tsx';
import { Accordion, Panel, type PanelProps } from './ui/accordion/index.ts';
import {
  LanIcon,
  PublicIcon,
  SpeedIcon,
  SyncAltIcon,
  TimerIcon,
} from './ui/icons/index.tsx';
import { Section, SectionRow } from './ui/section/index.ts';
import { styled } from './ui/styles/index.ts';

const Framed = styled('div', ({ $theme }) => ({
  overflow: 'hidden',
  ...expandBorderStyles($theme.borders.border200),
  borderRadius: $theme.borders.radius500,
  backgroundColor: $theme.colors.backgroundPrimary,
}));

const PanelTitle = styled('span', ({ $theme }) => ({
  flexGrow: 1,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale400,
}));

const PanelIcon = styled('span', ({ $theme }) => ({
  display: 'inline-flex',
  color: $theme.colors.contentTertiary,
}));

const Summary = styled('span', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  marginInlineStart: 'auto',
  paddingInlineEnd: $theme.sizing.scale400,
  color: $theme.colors.contentSecondary,
}));

const Body = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale500,
}));

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function clientIpText(clientIp: ClientIpSettings): string {
  switch (clientIp.source) {
    case 'vercel':
      return "Vercel's headers";
    case 'function':
      return 'A function of yours';
    case 'header':
      return clientIp.trustedHops === 0
        ? `The ${clientIp.header} header`
        : `The ${clientIp.header} header, ${plural(clientIp.trustedHops, 'proxy', 'proxies')} back`;
    default:
      return 'Unknown';
  }
}

export function ruleText(rule: RateLimitRuleSettings): string {
  const who =
    rule.audience === 'guest'
      ? 'guests'
      : rule.audience === 'auth'
        ? 'signed-in callers'
        : 'everyone';
  return `${plural(rule.max, 'request', 'requests')} per ${plural(rule.window, 'second', 'seconds')}, ${who}`;
}

export function timeoutText(milliseconds: number): string {
  if (milliseconds === 0) return 'No limit';
  return milliseconds % 1000 === 0
    ? plural(milliseconds / 1000, 'second', 'seconds')
    : `${milliseconds} ms`;
}

export function realtimeText(
  realtime: ApplicationSettings['realtime'],
): string {
  if (!realtime) return 'Off';
  return realtime.collections === null
    ? 'Every collection'
    : plural(realtime.collections.length, 'collection', 'collections');
}

function Row({
  title,
  icon,
  summary,
  children,
  ...panel
}: Omit<PanelProps, 'title' | 'children'> & {
  title: string;
  icon: ReactNode;
  summary: string;
  children: ReactNode;
}) {
  return (
    <Panel
      {...panel}
      title={
        <PanelTitle>
          <PanelIcon aria-hidden>{icon}</PanelIcon>
          {title}
          <Summary>{summary}</Summary>
        </PanelTitle>
      }
    >
      <Body>{children}</Body>
    </Panel>
  );
}

function Panels({ app }: { app: ApplicationSettings }) {
  return (
    <Framed>
      <Accordion>
        <Row
          key="origins"
          title="Trusted origins"
          icon={<PublicIcon size={18} />}
          summary={
            app.trustedOrigins.length === 0
              ? 'This host only'
              : plural(app.trustedOrigins.length, 'host', 'hosts')
          }
        >
          <Hint>
            Other hosts allowed to write with the session cookie.{' '}
            <Code>trustedOrigins</Code>
          </Hint>
          {app.trustedOrigins.length > 0 && (
            <Codes items={app.trustedOrigins} />
          )}
        </Row>
        <Row
          key="proxy"
          title="Proxy headers"
          icon={<LanIcon size={18} />}
          summary={app.trustProxy ? 'Trusted' : 'Not trusted'}
        >
          <SectionRow
            label="Host"
            caption={
              <>
                Enable only behind your own proxy. <Code>trustProxy</Code>
              </>
            }
          >
            <Value>
              {app.trustProxy
                ? 'Read from X-Forwarded-Host'
                : 'Read from the request'}
            </Value>
          </SectionRow>
          <SectionRow
            label="Client IP"
            caption={
              <>
                For logs and rate limits only. <Code>clientIp</Code>
              </>
            }
          >
            <Value>{clientIpText(app.clientIp)}</Value>
          </SectionRow>
        </Row>
        <Row
          key="rates"
          title="Rate limiting"
          icon={<SpeedIcon size={18} />}
          summary={
            app.rateLimits
              ? plural(app.rateLimits.rules.length, 'rule', 'rules')
              : 'Off'
          }
        >
          <Hint>
            Counted in the database: signed-in callers per record, guests per
            IP. <Code>rateLimits</Code>
          </Hint>
          {app.rateLimits?.rules.map((rule) => (
            <SectionRow
              key={`${rule.label} ${rule.audience}`}
              label={<Code>{rule.label}</Code>}
            >
              <Value>{ruleText(rule)}</Value>
            </SectionRow>
          ))}
          {app.rateLimits && app.rateLimits.excludedIps.length > 0 && (
            <SectionRow label="Never limited">
              <Codes items={app.rateLimits.excludedIps} />
            </SectionRow>
          )}
        </Row>
        <Row
          key="realtime"
          title="Realtime"
          icon={<SyncAltIcon size={18} />}
          summary={realtimeText(app.realtime)}
        >
          <Hint>
            Collections clients can subscribe to. <Code>realtime</Code>
          </Hint>
          {app.realtime?.collections && (
            <Codes items={app.realtime.collections} />
          )}
          {app.realtime && (
            <SectionRow label="Streams" caption="Then the client reconnects.">
              <Value>
                Open {plural(app.realtime.streamSeconds, 'second', 'seconds')}
              </Value>
            </SectionRow>
          )}
        </Row>
        <Row
          key="timeout"
          title="Statement timeout"
          icon={<TimerIcon size={18} />}
          summary={timeoutText(app.statementTimeout)}
        >
          <Hint>
            The longest a records API query may run, so an expensive filter
            cannot hold the database. <Code>statementTimeout</Code>
          </Hint>
        </Row>
      </Accordion>
    </Framed>
  );
}

export function ApplicationSettingsPage({
  settings,
  failed,
  icon,
}: {
  settings: SettingsModel | undefined;
  failed: string | undefined;
  icon: ReactNode;
}) {
  const app = settings?.application;
  return (
    <SettingsPage title="Application" icon={icon} failed={failed}>
      <Section title="Application" icon={icon}>
        <Hint>
          Set with the options of <Code>nextbase()</Code>.
        </Hint>
        <SectionRow
          label="Application URL"
          caption={
            <>
              For email links and OAuth2 redirects. <Code>appUrl</Code>
            </>
          }
        >
          {app &&
            (app.appUrl ? (
              <ValueCode>{app.appUrl}</ValueCode>
            ) : (
              <Value>Not set</Value>
            ))}
        </SectionRow>
        <SectionRow label="Base path" caption={<Code>basePath</Code>}>
          {app && <ValueCode>{app.basePath}</ValueCode>}
        </SectionRow>
      </Section>
      {app && <Panels app={app} />}
    </SettingsPage>
  );
}
