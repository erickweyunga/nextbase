import { StatefulMenu } from 'baseui/menu';
import { PLACEMENT, Popover, type PopoverPlacement } from 'baseui/popover';
import { type ReactElement, useId, useState } from 'react';
import { POPPER_OPTIONS, popoverBodyMotion } from '../popover/popover';

// Long items, such as saved replies, wrap instead of stretching the menu across the page.
const MENU_OVERRIDES = {
  List: {
    style: { minWidth: '200px', maxWidth: 'min(320px, calc(100vw - 32px))' },
  },
};

const POPOVER_OVERRIDES = { Body: { style: popoverBodyMotion } };

export interface DropdownMenuItem {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface DropdownMenuProps {
  items: DropdownMenuItem[];
  /** The trigger, e.g. a Button; it gets the open/close handlers and ARIA attributes. */
  children: ReactElement;
  placement?: PopoverPlacement;
  /** A fixed menu width in px, e.g. to match a surrounding box. */
  width?: number;
  /** Shifts the menu along its edge in px, e.g. to line it up with that box rather than the trigger. */
  offset?: number;
}

/**
 * A button that opens a menu of actions. Controlled so the popover id comes
 * from useId: baseui's react-uid counter differs between server and client.
 */
export function DropdownMenu({
  items,
  children,
  placement = PLACEMENT.bottomRight,
  width,
  offset,
}: DropdownMenuProps) {
  const id = useId();
  const [isOpen, setIsOpen] = useState(false);
  const close = () => setIsOpen(false);

  return (
    <Popover
      id={id}
      isOpen={isOpen}
      placement={placement}
      autoFocus
      returnFocus
      onClick={() => setIsOpen(!isOpen)}
      onClickOutside={close}
      onEsc={close}
      overrides={POPOVER_OVERRIDES}
      popperOptions={
        offset
          ? {
              modifiers: {
                ...POPPER_OPTIONS.modifiers,
                offset: { offset: `${offset}px, 0` },
              },
            }
          : POPPER_OPTIONS
      }
      content={
        <StatefulMenu
          items={items}
          onItemSelect={({ item }: { item: DropdownMenuItem }) => {
            close();
            item.onSelect();
          }}
          overrides={
            width
              ? {
                  List: {
                    style: {
                      width: `${width}px`,
                      maxWidth: 'calc(100vw - 32px)',
                    },
                  },
                }
              : MENU_OVERRIDES
          }
        />
      }
    >
      {children}
    </Popover>
  );
}
