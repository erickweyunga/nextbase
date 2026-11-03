import type { Theme } from 'baseui';
import { mergeOverrides } from 'baseui/helpers/overrides';
import { Select as BaseSelect, SIZE } from 'baseui/select';
import { useId } from 'react';
import { popoverBodyMotion } from '../popover/popover';
import type { PropsOf } from '../props-of';

export type SelectProps = PropsOf<typeof BaseSelect>;

// baseui centres the clear and arrow icons on the whole field; with tags on several lines that floats them
// between lines. Docked to the bottom they stay beside the last line, and a one-line field looks the same.
const ICON_OVERRIDES = {
  IconsContainer: {
    style: ({ $theme }: { $theme: Theme }) => ({
      alignItems: 'flex-end',
      paddingBottom: $theme.sizing.scale400,
    }),
  },
  Tag: { props: { overrides: { Action: { style: { cursor: 'pointer' } } } } },
};

const POPOVER_OVERRIDES = { Body: { style: popoverBodyMotion } };

/**
 * baseui's Select, compact by default. Its popover id otherwise comes from a
 * react-uid counter that differs between server and client; useId keeps it stable.
 */
export function Select({
  size = SIZE.compact,
  overrides,
  ...props
}: SelectProps) {
  const popoverId = useId();

  return (
    <BaseSelect
      size={size}
      {...props}
      overrides={mergeOverrides(
        {
          ...ICON_OVERRIDES,
          Popover: { props: { id: popoverId, overrides: POPOVER_OVERRIDES } },
        },
        overrides,
      )}
    />
  );
}
