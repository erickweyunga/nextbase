import { styled, type Theme } from 'baseui';
import { mergeOverrides } from 'baseui/helpers/overrides';
import { expandBorderStyles } from 'baseui/styles';
import type { TableBuilderColumnProps } from 'baseui/table-semantic';
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useId,
} from 'react';
import type { StyleObject } from 'styletron-react';
import { TableBuilder, type TableBuilderProps } from './table';

// Framed like Section, so a table section sits in a column of sections as one of them.
const Frame = styled('section', ({ $theme }) => ({
  ...expandBorderStyles($theme.borders.border200),
  overflow: 'hidden',
  borderRadius: $theme.borders.radius500,
  backgroundColor: $theme.colors.backgroundPrimary,
}));

const Title = styled('h2', ({ $theme }) => ({
  ...$theme.typography.LabelMedium,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale400,
  margin: 0,
  color: $theme.colors.contentPrimary,
}));

const Icon = styled('span', ({ $theme }) => ({
  display: 'inline-flex',
  flexShrink: 0,
  color: $theme.colors.contentTertiary,
}));

// The header row is the section's header, so it takes Section's header spacing, and the outer columns take its
// side spacing, so the title and the rows line up with the sections around it.
function sectionSpacing(first: boolean, last: boolean, head: boolean) {
  return ({ $theme }: { $theme: Theme }): StyleObject => {
    const side = (inset: string) => ({
      ...(first && { paddingLeft: inset }),
      ...(last && { paddingRight: inset }),
    });
    return {
      ...(head && {
        paddingTop: $theme.sizing.scale500,
        paddingBottom: $theme.sizing.scale500,
      }),
      ...side($theme.sizing.scale600),
      [$theme.mediaQuery.medium]: side($theme.sizing.scale700),
    };
  };
}

export type TableSectionProps<RowT> = TableBuilderProps<RowT> & {
  title: string;
  /** Decorative icon shown before the title. */
  icon?: ReactNode;
};

/**
 * A table that is a section of its own: one rounded card whose first column's header is the section's title,
 * in place of a separate header above the table.
 */
export function TableSection<RowT>({
  title,
  icon,
  children,
  ...props
}: TableSectionProps<RowT>) {
  const titleId = useId();
  const all = Children.toArray(children).filter(
    (child): child is ReactElement<TableBuilderColumnProps<RowT>> =>
      isValidElement<TableBuilderColumnProps<RowT>>(child),
  );
  const columns = all.map((column, i) => {
    const first = i === 0;
    const last = i === all.length - 1;
    return cloneElement(column, {
      ...(first && {
        header: (
          <Title id={titleId}>
            {icon && <Icon aria-hidden>{icon}</Icon>}
            {title}
          </Title>
        ),
      }),
      overrides: mergeOverrides(column.props.overrides, {
        TableHeadCell: { style: sectionSpacing(first, last, true) },
        TableBodyCell: { style: sectionSpacing(first, last, false) },
      }),
    });
  });
  return (
    <Frame aria-labelledby={titleId}>
      <TableBuilder {...props}>{columns}</TableBuilder>
    </Frame>
  );
}
