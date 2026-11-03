import { styled } from 'baseui';
import { expandBorderStyles } from 'baseui/styles';
import { type ReactNode, useEffect, useId, useRef } from 'react';

const Root = styled('section', ({ $theme }) => ({
  ...expandBorderStyles($theme.borders.border200),
  borderRadius: $theme.borders.radius500,
  backgroundColor: $theme.colors.backgroundPrimary,
}));

const Header = styled('header', ({ $theme }) => ({
  ...expandBorderStyles($theme.borders.border200),
  borderTopStyle: 'none',
  borderRightStyle: 'none',
  borderLeftStyle: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale400,
  paddingBlock: $theme.sizing.scale500,
  paddingInline: $theme.sizing.scale600,
  [$theme.mediaQuery.medium]: {
    paddingInline: $theme.sizing.scale700,
  },
}));

const Icon = styled('span', ({ $theme }) => ({
  display: 'inline-flex',
  flexShrink: 0,
  color: $theme.colors.contentTertiary,
}));

const Title = styled('h2', ({ $theme }) => ({
  ...$theme.typography.LabelMedium,
  margin: 0,
  color: $theme.colors.contentPrimary,
}));

const Action = styled('div', ({ $theme }) => ({
  display: 'flex',
  marginBlock: `calc(-1 * ${$theme.sizing.scale200})`,
  marginInlineStart: 'auto',
}));

const Body = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale600,
  padding: $theme.sizing.scale600,
  [$theme.mediaQuery.medium]: {
    padding: $theme.sizing.scale700,
  },
}));

export interface SectionProps {
  title: ReactNode;
  /** Decorative icon shown before the title. Hidden from assistive technology. */
  icon?: ReactNode;
  /** An anchor, so a link can open the page at this section (e.g. "#compliance"). */
  id?: string;
  /** End of the header, e.g. a button that adds to the section. */
  action?: ReactNode;
  children: ReactNode;
}

/** A titled card that groups related content, e.g. one block of a settings page. */
export function Section({ title, icon, id, action, children }: SectionProps) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);

  // The browser's own jump to "#id" happens before the page's sections have loaded, and only scrolls the window,
  // while the app's pages scroll in their own area; so a linked section brings itself into view once it's there.
  useEffect(() => {
    if (id && window.location.hash === `#${id}`)
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [id]);

  return (
    <Root ref={ref} id={id} aria-labelledby={titleId}>
      <Header>
        {icon && <Icon aria-hidden>{icon}</Icon>}
        <Title id={titleId}>{title}</Title>
        {action && <Action>{action}</Action>}
      </Header>
      <Body>{children}</Body>
    </Root>
  );
}

const Row = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale300,
  [$theme.mediaQuery.medium]: {
    gridTemplateColumns: 'minmax(0, 160px) minmax(0, 1fr)',
    columnGap: $theme.sizing.scale600,
    alignItems: 'center',
  },
}));

const RowLabel = styled('div', ({ $theme }) => ({
  ...$theme.typography.LabelSmall,
  color: $theme.colors.contentTertiary,
}));

const RowContent = styled<'div', { $align: 'start' | 'end' }>(
  'div',
  ({ $theme, $align }) => ({
    display: 'grid',
    justifyItems: 'start',
    rowGap: $theme.sizing.scale200,
    [$theme.mediaQuery.medium]: {
      justifyItems: $align,
    },
  }),
);

const RowCaption = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphXSmall,
  margin: 0,
  color: $theme.colors.contentTertiary,
}));

export interface SectionRowProps {
  label: ReactNode;
  caption?: ReactNode;
  /** Where the controls sit in their column on wider screens. Rows always stack start-aligned on small screens. */
  align?: 'start' | 'end';
  children: ReactNode;
}

/** A labelled row inside a Section: label on the left, controls on the right, stacked on small screens. */
export function SectionRow({
  label,
  caption,
  align = 'start',
  children,
}: SectionRowProps) {
  const labelId = useId();

  return (
    <Row role="group" aria-labelledby={labelId}>
      <RowLabel id={labelId}>{label}</RowLabel>
      <RowContent $align={align}>
        {children}
        {caption && <RowCaption>{caption}</RowCaption>}
      </RowContent>
    </Row>
  );
}
