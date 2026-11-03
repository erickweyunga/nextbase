import { SIZE } from 'baseui/button';
import { ButtonGroup as BaseButtonGroup } from 'baseui/button-group';
import type { PropsOf } from '../props-of';

export type ButtonGroupProps = PropsOf<typeof BaseButtonGroup>;

/** baseui's ButtonGroup, compact by default. */
export function ButtonGroup({
  size = SIZE.compact,
  ...props
}: ButtonGroupProps) {
  return <BaseButtonGroup size={size} {...props} />;
}
