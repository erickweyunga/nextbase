import { mergeOverrides } from 'baseui/helpers/overrides';
import { SIZE } from 'baseui/input';
import {
  TimePicker as BaseTimePicker,
  type TimePickerProps as BaseTimePickerProps,
} from 'baseui/timepicker';
import { Select } from '../select/select';

// Works with Dates through baseui's default date-fns adapter.
export type TimePickerProps = Omit<BaseTimePickerProps<Date>, 'adapter'> & {
  /** Names the field for assistive technology; baseui otherwise announces a generic "Select a time". */
  'aria-label'?: string;
};

/** baseui's TimePicker, compact by default and rendered with our Select. */
export function TimePicker({
  size = SIZE.compact,
  overrides,
  'aria-label': ariaLabel,
  ...props
}: TimePickerProps) {
  return (
    <BaseTimePicker
      size={size}
      {...props}
      overrides={mergeOverrides(
        {
          Select: {
            component: Select,
            props: ariaLabel ? { 'aria-label': ariaLabel } : {},
          },
        },
        overrides,
      )}
    />
  );
}
