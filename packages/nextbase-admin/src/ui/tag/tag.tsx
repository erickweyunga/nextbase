import { mergeOverrides } from 'baseui/helpers/overrides';
import { Tag as BaseTag, SIZE } from 'baseui/tag';
import type { PropsOf } from '../props-of';

export type TagProps = PropsOf<typeof BaseTag>;

// A tint of the text colour, so every kind gets a matching border.
const BORDER = '1px solid color-mix(in srgb, currentColor 25%, transparent)';

const ROOT_STYLE = {
  margin: 0,
  borderTop: BORDER,
  borderRight: BORDER,
  borderBottom: BORDER,
  borderLeft: BORDER,
};

/** baseui's Tag: small, not closeable, outlined in its own colour and without baseui's outer margin by default. */
export function Tag({
  size = SIZE.small,
  closeable = false,
  overrides,
  ...props
}: TagProps) {
  return (
    <BaseTag
      size={size}
      closeable={closeable}
      {...props}
      overrides={mergeOverrides({ Root: { style: ROOT_STYLE } }, overrides)}
    />
  );
}
