import { Drawer as BaseDrawer } from 'baseui/drawer';
import { mergeOverrides } from 'baseui/helpers/overrides';
import type { PropsOf } from '../props-of';

export type DrawerProps = PropsOf<typeof BaseDrawer> & {
  /** Accessible name of the drawer, e.g. "Navigation menu" or the customer's name. */
  label: string;
};

/**
 * baseui's Drawer as a labelled modal dialog (baseui's has no dialog semantics),
 * with no body margin so content can run edge to edge.
 */
export function Drawer({ label, overrides, ...props }: DrawerProps) {
  return (
    <BaseDrawer
      {...props}
      overrides={mergeOverrides(
        {
          DrawerContainer: {
            props: { role: 'dialog', 'aria-modal': true, 'aria-label': label },
          },
          DrawerBody: { style: { margin: 0, height: '100%' } },
        },
        overrides,
      )}
    />
  );
}
