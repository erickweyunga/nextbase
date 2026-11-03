import {
  DatePicker as BaseDatePicker,
  type DatepickerProps as BaseDatePickerProps,
} from 'baseui/datepicker';
import { mergeOverrides } from 'baseui/helpers/overrides';
import { SIZE } from 'baseui/input';
import type { ComponentProps } from 'react';
import { Input } from '../input/input';

// Works with Dates through baseui's default date-fns adapter.
export type DatePickerProps = Omit<
  BaseDatePickerProps<Date>,
  'adapter' | 'mask'
>;

// baseui's default MaskedInput uses react-input-mask, which calls findDOMNode, gone in React 19. Dates are
// typed in full ("Oct 28, 2026") or picked, so a plain input is enough.
function DateInput(props: ComponentProps<typeof Input> & { mask?: unknown }) {
  const inputProps = { ...props };
  delete inputProps.mask;
  return <Input {...inputProps} />;
}

/** baseui's DatePicker, compact like Input: a typed or picked date, shown as e.g. "Oct 28, 2026". */
export function DatePicker({
  size = SIZE.compact,
  formatString = 'MMM d, yyyy',
  overrides,
  ...props
}: DatePickerProps) {
  return (
    <BaseDatePicker
      size={size}
      formatString={formatString}
      mask={null}
      {...props}
      overrides={mergeOverrides({ Input: { component: DateInput } }, overrides)}
    />
  );
}
