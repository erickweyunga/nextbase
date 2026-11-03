import { Switch as BaseSwitch, LABEL_PLACEMENT, SIZE } from 'baseui/switch';
import type { ReactNode } from 'react';
import type { PropsOf } from '../props-of';

export type SwitchProps = PropsOf<typeof BaseSwitch>;

/** baseui's Switch, small and showing its check/cross icon by default. */
export function Switch({
  size = SIZE.small,
  showIcon = true,
  ...props
}: SwitchProps) {
  return <BaseSwitch size={size} showIcon={showIcon} {...props} />;
}

export type SwitchRowProps = Omit<
  SwitchProps,
  'children' | 'labelPlacement' | 'overrides'
> & {
  label: ReactNode;
};

/**
 * A full-width setting row: label on the left, switch on the right. The label
 * dims while the switch is off. The whole row is the click target.
 */
export function SwitchRow({ label, ...props }: SwitchRowProps) {
  return (
    <Switch
      {...props}
      labelPlacement={LABEL_PLACEMENT.left}
      overrides={{
        Root: {
          style: ({ $theme }) => ({
            display: 'flex',
            alignItems: 'center',
            gap: $theme.sizing.scale600,
          }),
        },
        Label: {
          style: ({ $theme, $checked, $disabled }) => ({
            ...$theme.typography.LabelSmall,
            flexGrow: 1,
            paddingTop: 0,
            paddingRight: 0,
            paddingLeft: 0,
            color: $disabled
              ? $theme.colors.contentStateDisabled
              : $checked
                ? $theme.colors.contentPrimary
                : $theme.colors.contentTertiary,
          }),
        },
      }}
    >
      {label}
    </Switch>
  );
}
