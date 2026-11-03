import type { RecordModel } from '@nextbasejs/client';
import type { ReactNode } from 'react';
import { Brand } from './components/brand.tsx';
import { AccountMenu } from './ui/account-menu/index.ts';
import {
  ContrastIcon,
  DarkModeIcon,
  DatabaseIcon,
  GroupIcon,
  LightModeIcon,
  LogoutIcon,
  MonitoringIcon,
  PersonIcon,
  SettingsIcon,
  WifiIcon,
} from './ui/icons/index.tsx';
import { type ColorMode, useColorMode } from './ui/provider/index.ts';
import { Sidebar, SidebarLayout, SidebarLink } from './ui/sidebar/index.ts';
import {
  cookieFlag,
  SIDEBAR_COLLAPSED_COOKIE,
} from './ui/sidebar-cookie/index.ts';

const ICON = 20;

const THEME_LABELS: Record<ColorMode, string> = {
  system: 'Theme: System',
  light: 'Theme: Light',
  dark: 'Theme: Dark',
};

const THEME_ICONS: Record<ColorMode, ReactNode> = {
  system: <ContrastIcon size={ICON} aria-hidden />,
  light: <LightModeIcon size={ICON} aria-hidden />,
  dark: <DarkModeIcon size={ICON} aria-hidden />,
};

const NEXT_MODE: Record<ColorMode, ColorMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const NAV = [
  {
    title: 'Collections',
    href: '/collections',
    icon: <DatabaseIcon size={ICON} />,
  },
  {
    title: 'Observability',
    href: '/observability',
    icon: <MonitoringIcon size={ICON} />,
  },
  { title: 'Settings', href: '/settings', icon: <SettingsIcon size={ICON} /> },
];

export function Shell({
  superuser,
  onSignOut,
  children,
}: {
  superuser: RecordModel;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const email = String(superuser.email ?? '');
  const { mode, setMode } = useColorMode();
  return (
    <SidebarLayout
      framed
      // Collapsed until the user opens it.
      defaultCollapsed={cookieFlag(SIDEBAR_COLLAPSED_COOKIE, true)}
      brand={<Brand />}
      sidebar={
        <Sidebar
          header={<Brand />}
          items={NAV}
          footer={
            <>
              <SidebarLink
                title="Health"
                href="/health"
                icon={<WifiIcon size={ICON} />}
              />
              <AccountMenu
                name={email}
                email={email}
                placeholder={(size) => <PersonIcon size={size} aria-hidden />}
                groups={[
                  [
                    {
                      label: 'Manage superusers',
                      href: '/collections',
                      icon: <GroupIcon size={ICON} aria-hidden />,
                    },
                  ],
                  [
                    {
                      label: THEME_LABELS[mode],
                      icon: THEME_ICONS[mode],
                      onSelect: () => setMode(NEXT_MODE[mode]),
                    },
                  ],
                  [
                    {
                      label: 'Sign out',
                      tone: 'danger',
                      icon: <LogoutIcon size={ICON} aria-hidden />,
                      onSelect: onSignOut,
                    },
                  ],
                ]}
              />
            </>
          }
        />
      }
    >
      {children}
    </SidebarLayout>
  );
}
