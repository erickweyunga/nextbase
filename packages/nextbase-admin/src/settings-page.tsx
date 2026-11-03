import type { ReactNode } from 'react';
import { Page } from './components/page.tsx';
import { EmptyState } from './ui/empty-state/index.ts';
import { styled } from './ui/styles/index.ts';

export const Value = styled('span', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  color: $theme.colors.contentPrimary,
  overflowWrap: 'anywhere',
}));

export const Code = styled('code', ({ $theme }) => ({
  ...$theme.typography.MonoParagraphXSmall,
}));

export const ValueCode = styled('code', ({ $theme }) => ({
  ...$theme.typography.MonoParagraphSmall,
  color: $theme.colors.contentPrimary,
  overflowWrap: 'anywhere',
}));

export const Hint = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  margin: 0,
  color: $theme.colors.contentSecondary,
}));

const List = styled('ul', ({ $theme }) => ({
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'grid',
  rowGap: $theme.sizing.scale200,
}));

export function Codes({ items }: { items: readonly string[] }) {
  return (
    <List>
      {items.map((item) => (
        <li key={item}>
          <ValueCode>{item}</ValueCode>
        </li>
      ))}
    </List>
  );
}

export function SettingsPage({
  title,
  icon,
  failed,
  children,
}: {
  title: string;
  icon: ReactNode;
  failed: string | undefined;
  children: ReactNode;
}) {
  return (
    <Page title={title} icon={icon}>
      {failed ? <EmptyState icon={icon} title={failed} /> : children}
    </Page>
  );
}
