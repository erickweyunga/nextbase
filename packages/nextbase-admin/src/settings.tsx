import type { SettingsModel } from '@nextbasejs/client';
import { type ReactNode, useEffect, useState } from 'react';
import { nb } from './api.ts';
import { ApplicationSettingsPage } from './application-settings.tsx';
import { Body } from './components/page.tsx';
import { LogsSettings } from './logs-settings.tsx';
import { MailSettingsPage } from './mail-settings.tsx';
import { Migrations } from './migrations.tsx';
import { OAuth2SettingsPage } from './oauth2-settings.tsx';
import { SecuritySettingsPage } from './security-settings.tsx';
import { StorageSettingsPage } from './storage-settings.tsx';
import {
  EventListIcon,
  HistoryIcon,
  HomeIcon,
  KeyIcon,
  LoginIcon,
  MailIcon,
  StorageIcon,
} from './ui/icons/index.tsx';
import { navigate } from './ui/navigation.tsx';
import {
  type SidebarEntry,
  SidebarPanel,
  SidebarPanelLayout,
} from './ui/sidebar/index.ts';

const ICON = 20;

interface PageProps {
  settings: SettingsModel | undefined;
  failed: string | undefined;
  icon: ReactNode;
}

interface SettingsPage {
  title: string;
  href: string;
  icon: ReactNode;
  render: (props: PageProps) => ReactNode;
}

const page = (
  title: string,
  slug: string,
  icon: ReactNode,
  render: SettingsPage['render'],
): SettingsPage => ({ title, href: `/settings/${slug}`, icon, render });

const APPLICATION = page(
  'Application',
  'application',
  <HomeIcon size={ICON} />,
  (props) => <ApplicationSettingsPage {...props} />,
);

const GROUPS: readonly { label: string; items: readonly SettingsPage[] }[] = [
  {
    label: 'System',
    items: [
      APPLICATION,
      page('Mail', 'mail', <MailIcon size={ICON} />, (props) => (
        <MailSettingsPage {...props} />
      )),
      page('File storage', 'storage', <StorageIcon size={ICON} />, (props) => (
        <StorageSettingsPage {...props} />
      )),
      page('Logs', 'logs', <EventListIcon size={ICON} />, (props) => (
        <LogsSettings {...props} />
      )),
    ],
  },
  {
    label: 'Auth',
    items: [
      page('OAuth2 providers', 'oauth2', <LoginIcon size={ICON} />, (props) => (
        <OAuth2SettingsPage {...props} />
      )),
      page('Security', 'security', <KeyIcon size={ICON} />, (props) => (
        <SecuritySettingsPage {...props} />
      )),
    ],
  },
  {
    label: 'Data',
    items: [
      page(
        'Migrations',
        'migrations',
        <HistoryIcon size={ICON} />,
        ({ icon }) => <Migrations icon={icon} />,
      ),
    ],
  },
];

const PAGES = GROUPS.flatMap((group) => group.items);

const ENTRIES: SidebarEntry[] = GROUPS.map((group) => ({
  label: group.label,
  items: group.items.map(({ title, href, icon }) => ({ title, href, icon })),
}));

export function Settings({ path }: { path: string }) {
  const [settings, setSettings] = useState<SettingsModel>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    nb.settings
      .get()
      .then(setSettings)
      .catch((error: unknown) =>
        setFailed(error instanceof Error ? error.message : String(error)),
      );
  }, []);
  const current = PAGES.find((p) => path === p.href);

  useEffect(() => {
    if (!current) navigate(APPLICATION.href, { replace: true });
  }, [current]);

  return (
    <SidebarPanelLayout
      panel={<SidebarPanel label="Settings" items={ENTRIES} />}
    >
      <Body>{current?.render({ settings, failed, icon: current.icon })}</Body>
    </SidebarPanelLayout>
  );
}
