import { styled } from 'baseui';
import { expandBorderStyles } from 'baseui/styles';
import type { ReactNode } from 'react';

const Root = styled<'div', { $framed: boolean }>(
  'div',
  ({ $theme, $framed }) => ({
    ...($framed ? expandBorderStyles($theme.borders.border200) : {}),
    display: 'grid',
    justifyItems: 'center',
    rowGap: $theme.sizing.scale300,
    paddingBlock: $theme.sizing.scale1600,
    paddingInline: $theme.sizing.scale800,
    borderRadius: $theme.borders.radius500,
    backgroundColor: $framed ? $theme.colors.backgroundPrimary : 'transparent',
    textAlign: 'center',
  }),
);

// The icon on its own, large and in muted ink: no circle behind it.
const Icon = styled('span', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginBlockEnd: $theme.sizing.scale500,
  color: $theme.colors.contentTertiary,
}));

const Illustration = styled('span', ({ $theme }) => ({
  display: 'flex',
  justifyContent: 'center',
  width: '120px',
  marginBlockEnd: $theme.sizing.scale500,
}));

const Title = styled('h2', ({ $theme }) => ({
  ...$theme.typography.LabelLarge,
  margin: 0,
  color: $theme.colors.contentPrimary,
}));

const Description = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  maxWidth: '360px',
  margin: 0,
  color: $theme.colors.contentTertiary,
}));

const Action = styled('div', ({ $theme }) => ({
  marginBlockStart: $theme.sizing.scale500,
}));

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Decorative icon above the title, on its own in muted ink; 64px with a 1.5 stroke reads well. */
  icon?: ReactNode;
  /** A larger picture above the title, shown as is; takes the place of `icon`. */
  illustration?: ReactNode;
  /** E.g. a button that creates the first item. */
  action?: ReactNode;
  /** Its own bordered card; turn off inside something that already has one, like a table. */
  framed?: boolean;
}

/** Placeholder for a list or page with nothing to show yet. */
export function EmptyState({
  title,
  description,
  icon,
  illustration,
  action,
  framed = true,
}: EmptyStateProps) {
  return (
    <Root $framed={framed}>
      {illustration ? (
        <Illustration aria-hidden>{illustration}</Illustration>
      ) : (
        icon && <Icon aria-hidden>{icon}</Icon>
      )}
      <Title>{title}</Title>
      {description && <Description>{description}</Description>}
      {action && <Action>{action}</Action>}
    </Root>
  );
}
