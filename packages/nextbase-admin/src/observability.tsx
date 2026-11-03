import { useEffect } from 'react';
import { Analytics } from './analytics.tsx';
import { Body } from './components/page.tsx';
import { Events } from './events.tsx';
import { BarChartIcon, EventListIcon } from './ui/icons/index.tsx';
import { navigate } from './ui/navigation.tsx';
import { SidebarPanel, SidebarPanelLayout } from './ui/sidebar/index.ts';

const ICON = 20;

const EVENTS = '/observability/events';
const ANALYTICS = '/observability/analytics';

const ITEMS = [
  { title: 'Events', href: EVENTS, icon: <EventListIcon size={ICON} /> },
  { title: 'Analytics', href: ANALYTICS, icon: <BarChartIcon size={ICON} /> },
];

export function Observability({ path }: { path: string }) {
  const analytics = path.startsWith(ANALYTICS);

  useEffect(() => {
    if (path !== EVENTS && !analytics) navigate(EVENTS);
  }, [path, analytics]);

  return (
    <SidebarPanelLayout
      panel={<SidebarPanel label="Observability" items={ITEMS} />}
    >
      <Body>
        {analytics ? (
          <Analytics icon={<BarChartIcon size={ICON} />} />
        ) : (
          <Events icon={<EventListIcon size={ICON} />} />
        )}
      </Body>
    </SidebarPanelLayout>
  );
}
