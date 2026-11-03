import {
  PhoneInput as BasePhoneInput,
  StatefulPhoneInput as BaseStatefulPhoneInput,
  SIZE,
} from 'baseui/phone-input';
import type { PropsOf } from '../props-of';

export type PhoneInputProps = PropsOf<typeof BasePhoneInput>;
export type StatefulPhoneInputProps = PropsOf<typeof BaseStatefulPhoneInput>;

/** baseui's PhoneInput, compact by default. */
export function PhoneInput({ size = SIZE.compact, ...props }: PhoneInputProps) {
  return <BasePhoneInput size={size} {...props} />;
}

/** baseui's StatefulPhoneInput, compact by default. */
export function StatefulPhoneInput({
  size = SIZE.compact,
  ...props
}: StatefulPhoneInputProps) {
  return <BaseStatefulPhoneInput size={size} {...props} />;
}
