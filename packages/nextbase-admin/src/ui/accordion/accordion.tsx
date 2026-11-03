import type { Theme } from 'baseui';
import {
  Accordion as BaseAccordion,
  type PanelProps,
  StyledRoot,
} from 'baseui/accordion';
import { mergeOverrides } from 'baseui/helpers/overrides';
import {
  Children,
  cloneElement,
  isValidElement,
  type Key,
  type ReactNode,
} from 'react';
import type { PropsOf } from '../props-of';

export type AccordionProps = PropsOf<typeof BaseAccordion>;

// Compact grey section headers with a hairline between sections, for dense side panels.
const OVERRIDES = {
  Header: {
    style: ({ $theme }: { $theme: Theme }) => ({
      ...$theme.typography.LabelMedium,
      paddingTop: $theme.sizing.scale400,
      paddingBottom: $theme.sizing.scale400,
      paddingLeft: $theme.sizing.scale600,
      paddingRight: $theme.sizing.scale600,
      backgroundColor: $theme.colors.backgroundSecondary,
      ':hover': {
        color: $theme.colors.contentPrimary,
        backgroundColor: $theme.colors.backgroundTertiary,
      },
    }),
  },
  // baseui keeps an opening section at the height it measured until its animation reports the end, which can
  // fail to come, and content that grows meanwhile (a field added, an input loading) is cut off. An open section
  // always fits its content; closing still animates.
  ContentAnimationContainer: {
    style: ({ $expanded }: { $expanded: boolean }) =>
      $expanded ? { height: 'auto' } : {},
  },
  Content: {
    style: ({ $theme }: { $theme: Theme }) => ({
      ...$theme.typography.ParagraphMedium,
      paddingTop: $theme.sizing.scale500,
      paddingBottom: $theme.sizing.scale500,
      paddingLeft: $theme.sizing.scale600,
      paddingRight: $theme.sizing.scale600,
      backgroundColor: $theme.colors.backgroundPrimary,
    }),
  },
};

/** baseui's Accordion with compact grey section headers; panels open independently by default. */
export function Accordion({
  accordion = false,
  overrides,
  ...props
}: AccordionProps) {
  return (
    <BaseAccordion
      accordion={accordion}
      {...props}
      overrides={mergeOverrides(OVERRIDES, overrides)}
    />
  );
}

export interface StatelessAccordionProps {
  /** The keys of the open panels. */
  expanded: Key[];
  /** Called with the open panels' keys after a header is clicked. */
  onChange?: (state: { key: Key; expanded: Key[] }) => void;
  /** Only one panel open at a time. */
  accordion?: boolean;
  children: ReactNode;
}

/**
 * The same Accordion, controlled: `expanded` lists the open panels' keys, so code can open one, e.g. a
 * section just added. Built here because baseui's StatelessAccordion checks its children with react-is 17,
 * which does not recognise React 19 elements, so its panels never open.
 */
export function StatelessAccordion({
  expanded,
  onChange,
  accordion = false,
  children,
}: StatelessAccordionProps) {
  return (
    <StyledRoot data-baseweb="accordion">
      {Children.map(children, (child, index) => {
        if (!isValidElement<PanelProps>(child)) return child;
        const key = child.key ?? String(index);
        const open = expanded.includes(key);
        return cloneElement(child, {
          key,
          expanded: open,
          overrides: mergeOverrides(OVERRIDES, child.props.overrides),
          onChange: () =>
            onChange?.({
              key,
              expanded: open
                ? expanded.filter((k) => k !== key)
                : accordion
                  ? [key]
                  : [...expanded, key],
            }),
        });
      })}
    </StyledRoot>
  );
}
