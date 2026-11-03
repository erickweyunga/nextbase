import { mergeOverrides } from 'baseui/helpers/overrides';
import {
  Input as BaseInput,
  StatefulInput as BaseStatefulInput,
  SIZE,
} from 'baseui/input';
import type { RefObject } from 'react';
import { COMPACT_CONTROL_HEIGHT } from '../control-height';
import type { PropsOf } from '../props-of';

/** baseui's Input props, with `inputRef` taking React 19's `useRef<HTMLInputElement>(null)`. */
export type InputProps = Omit<PropsOf<typeof BaseInput>, 'inputRef'> & {
  inputRef?: RefObject<HTMLInputElement | null>;
};
export type StatefulInputProps = PropsOf<typeof BaseStatefulInput>;

// Same height as compact buttons, so inputs and buttons line up side by side.
const COMPACT_OVERRIDES = {
  Root: { style: { boxSizing: 'border-box', height: COMPACT_CONTROL_HEIGHT } },
} as const;

const CONTROL_HEIGHTS: Partial<Record<string, string>> = {
  [SIZE.compact]: COMPACT_CONTROL_HEIGHT,
  [SIZE.default]: '48px',
};

// baseui pads the show-password button unevenly; a square at the end centres the eye.
function maskToggleOverrides(size: string) {
  const square = CONTROL_HEIGHTS[size];
  if (!square) return undefined;
  return {
    Root: { style: { paddingRight: 0 } },
    MaskToggleButton: {
      style: {
        justifyContent: 'center',
        alignSelf: 'stretch',
        flexShrink: 0,
        width: square,
        paddingLeft: 0,
        paddingRight: 0,
        cursor: 'pointer',
      },
    },
  };
}

function inputOverrides(
  size: string,
  type: string | undefined,
  overrides: InputProps['overrides'],
) {
  let base = size === SIZE.compact ? COMPACT_OVERRIDES : {};
  if (type === 'password')
    base = mergeOverrides(base, maskToggleOverrides(size));
  return mergeOverrides(base, overrides);
}

/** baseui's Input, compact (36px) by default. */
export function Input({
  size = SIZE.compact,
  overrides,
  inputRef,
  ...props
}: InputProps) {
  return (
    <BaseInput
      size={size}
      {...props}
      inputRef={inputRef as RefObject<HTMLInputElement> | undefined}
      overrides={inputOverrides(size, props.type, overrides)}
    />
  );
}

/** baseui's StatefulInput, compact (36px) by default. */
export function StatefulInput({
  size = SIZE.compact,
  overrides,
  ...props
}: StatefulInputProps) {
  return (
    <BaseStatefulInput
      size={size}
      {...props}
      overrides={inputOverrides(size, props.type, overrides)}
    />
  );
}
