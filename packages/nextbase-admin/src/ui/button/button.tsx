import type { Theme } from 'baseui';
import { Button as BaseButton, KIND, SHAPE, SIZE } from 'baseui/button';
import { mergeOverrides } from 'baseui/helpers/overrides';
import { COMPACT_CONTROL_HEIGHT } from '../control-height';
import type { PropsOf } from '../props-of';

export type ButtonProps = PropsOf<typeof BaseButton>;

interface ButtonStyleProps {
  $theme: Theme;
  $kind?: string;
  $size?: string;
  $shape?: string;
  $isSelected?: boolean;
  $disabled?: boolean;
}

// baseui fills secondary buttons with the app's background grey, so on the page
// they vanish; white with a hairline border reads on grey and on white surfaces.
// Disabled ones keep the outline and only dim their text, so they still read as buttons.
function secondaryStyle({
  $theme,
  $kind,
  $isSelected,
  $disabled,
}: ButtonStyleProps) {
  if ($kind !== KIND.secondary || $isSelected) return {};
  if ($disabled) {
    return {
      backgroundColor: $theme.colors.backgroundPrimary,
      boxShadow: `inset 0 0 0 1px ${$theme.colors.borderOpaque}`,
      color: $theme.colors.contentStateDisabled,
    };
  }
  return {
    backgroundColor: $theme.colors.backgroundPrimary,
    boxShadow: `inset 0 0 0 1px ${$theme.colors.borderOpaque}`,
    ':hover': { backgroundColor: $theme.colors.backgroundSecondary },
    ':active': { backgroundColor: $theme.colors.backgroundTertiary },
  };
}

// baseui derives height from padding and line height, which differ between text,
// icon-only, link and input controls; a fixed height lines them all up.
function compactStyle({ $size, $shape }: ButtonStyleProps) {
  if ($size !== SIZE.compact) return {};
  const iconOnly = $shape === SHAPE.square || $shape === SHAPE.circle;
  return {
    boxSizing: 'border-box',
    height: COMPACT_CONTROL_HEIGHT,
    width: iconOnly ? COMPACT_CONTROL_HEIGHT : undefined,
    paddingTop: 0,
    paddingBottom: 0,
  } as const;
}

function baseButtonStyle(props: ButtonStyleProps) {
  return { ...compactStyle(props), ...secondaryStyle(props) };
}

/** baseui's Button, compact (36px) by default; secondary buttons are white with a border. */
export function Button({
  size = SIZE.compact,
  overrides,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      size={size}
      {...props}
      overrides={mergeOverrides(
        { BaseButton: { style: baseButtonStyle } },
        overrides,
      )}
    />
  );
}
