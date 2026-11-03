import { styled } from 'baseui';
import { expandBorderStyles } from 'baseui/styles';
import type { ReactNode } from 'react';

const Rule = styled('hr', ({ $theme }) => ({
  ...expandBorderStyles($theme.borders.border200),
  borderRightStyle: 'none',
  borderBottomStyle: 'none',
  borderLeftStyle: 'none',
  flexGrow: 1,
  width: '100%',
  margin: 0,
}));

const Labelled = styled('div', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale600,
  color: $theme.colors.contentTertiary,
  whiteSpace: 'nowrap',
}));

export interface DividerProps {
  /** Text centred on the line, e.g. "more resources". */
  children?: ReactNode;
}

/** A horizontal rule, optionally with a centred label. */
export function Divider({ children }: DividerProps) {
  if (!children) return <Rule />;

  return (
    <Labelled>
      <Rule aria-hidden />
      {children}
      <Rule aria-hidden />
    </Labelled>
  );
}
