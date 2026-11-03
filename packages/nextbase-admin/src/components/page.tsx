import type { ReactNode } from 'react';
import { PageHeader } from '../ui/page-header/index.ts';
import { DESKTOP } from '../ui/sidebar/index.ts';
import { styled, type Theme } from '../ui/styles/index.ts';

export function desktopGutter($theme: Theme) {
  return {
    paddingInlineStart: $theme.sizing.scale0,
    paddingInlineEnd: $theme.sizing.scale400,
  };
}

const Area = styled('div', ({ $theme }) => ({
  boxSizing: 'border-box',
  minHeight: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  [DESKTOP]: {
    minHeight: 0,
    height: '100%',
    paddingTop: $theme.sizing.scale650,
    paddingBottom: $theme.sizing.scale300,
  },
}));

const Scroller = styled('div', {
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  [DESKTOP]: {
    minHeight: 0,
    overflowY: 'auto',
    scrollbarWidth: 'thin',
  },
});

export function Body({ children }: { children: ReactNode }) {
  return (
    <Area>
      <Scroller>{children}</Scroller>
    </Area>
  );
}

const Column = styled<'div', { $fill: boolean }>(
  'div',
  ({ $theme, $fill }) => ({
    flexGrow: 1,
    boxSizing: 'border-box',
    width: '100%',
    display: 'grid',
    gridTemplateRows: $fill ? 'auto 1fr' : undefined,
    alignContent: 'start',
    gap: $theme.sizing.scale700,
    maxWidth: '960px',
    margin: '0 auto',
    paddingTop: $theme.sizing.scale300,
    paddingBottom: $fill ? 0 : $theme.sizing.scale1000,
    paddingInline: $theme.sizing.scale800,
    [DESKTOP]: { paddingTop: 0, ...desktopGutter($theme) },
  }),
);

const FullWidth = styled('div', ({ $theme }) => ({
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: $theme.sizing.scale300,
  boxSizing: 'border-box',
  paddingTop: $theme.sizing.scale300,
  paddingInline: $theme.sizing.scale800,
  paddingBottom: $theme.sizing.scale800,
  [DESKTOP]: {
    minHeight: 0,
    paddingTop: 0,
    paddingBottom: $theme.sizing.scale0,
    ...desktopGutter($theme),
  },
}));

export function TablePage({ children }: { children: ReactNode }) {
  return <FullWidth>{children}</FullWidth>;
}

export function Page({
  title,
  icon,
  fill = false,
  children,
}: {
  title: string;
  icon: ReactNode;
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <Column $fill={fill}>
      <PageHeader title={title} icon={icon} />
      {children}
    </Column>
  );
}
