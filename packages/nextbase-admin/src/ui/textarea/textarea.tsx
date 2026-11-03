import { mergeOverrides } from 'baseui/helpers/overrides';
import { Textarea as BaseTextarea, SIZE } from 'baseui/textarea';
import type { RefObject } from 'react';
import type { PropsOf } from '../props-of';

/** baseui's Textarea props, with `inputRef` taking React 19's `useRef<HTMLTextAreaElement>(null)`. */
export type TextareaProps = Omit<PropsOf<typeof BaseTextarea>, 'inputRef'> & {
  inputRef?: RefObject<HTMLTextAreaElement | null>;
};

/** baseui's Textarea, compact by default. */
export function Textarea({
  size = SIZE.compact,
  overrides,
  inputRef,
  ...props
}: TextareaProps) {
  // baseui shrinks the root to fit-content whenever `resize` is set, which only
  // makes sense when the width can change. Vertical resizing keeps full width.
  const keepFullWidth = props.resize === 'vertical' || props.resize === 'block';

  return (
    <BaseTextarea
      size={size}
      {...props}
      inputRef={inputRef as RefObject<HTMLTextAreaElement> | undefined}
      overrides={
        keepFullWidth
          ? mergeOverrides({ Root: { style: { width: '100%' } } }, overrides)
          : overrides
      }
    />
  );
}
