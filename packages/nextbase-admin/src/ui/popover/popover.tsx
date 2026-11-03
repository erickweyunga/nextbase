import type { Theme } from 'baseui';
import {
  Popover as BasePopover,
  PLACEMENT,
  type PopoverPlacement,
} from 'baseui/popover';
import { type ReactElement, type ReactNode, useId, useState } from 'react';
import type { StyleObject } from 'styletron-react';

const OPPOSITE_SIDE: Record<string, string> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};
const ENTER_DISTANCE = 4;

interface BodyMotionProps {
  $theme: Theme;
  $isAnimating: boolean;
  $isOpen: boolean;
  $placement: PopoverPlacement;
  $popoverOffset: { top: number; left: number };
}

/**
 * Popover body style for an open that fades and grows slightly out of the trigger. baseui
 * positions the body through `transform`, so this rebuilds its translate with a shorter
 * slide than baseui's and adds the scale. Closing stays instant, as in baseui.
 */
export function popoverBodyMotion({
  $theme,
  $isAnimating,
  $isOpen,
  $placement,
  $popoverOffset,
}: BodyMotionProps): StyleObject {
  const [side = '', align] = $placement.split(/(?=[A-Z])/);
  const shown = $isAnimating && $isOpen;
  let { top, left } = $popoverOffset;
  if (!shown) {
    if (side === 'top') top += ENTER_DISTANCE;
    else if (side === 'bottom') top -= ENTER_DISTANCE;
    else if (side === 'left') left += ENTER_DISTANCE;
    else if (side === 'right') left -= ENTER_DISTANCE;
  }
  const origin = OPPOSITE_SIDE[side];
  return {
    transform: `translate3d(${left}px, ${top}px, 0)${shown ? '' : ' scale(0.98)'}`,
    transformOrigin: origin
      ? `${origin} ${align?.toLowerCase() ?? 'center'}`
      : 'center',
    transitionDuration: shown ? $theme.animation.timing150 : '0s',
    transitionTimingFunction: $theme.animation.easeOutCurve,
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0s' },
  };
}

const OVERRIDES = {
  Body: {
    style: (props: BodyMotionProps) => ({
      ...popoverBodyMotion(props),
      borderRadius: props.$theme.borders.radius400,
      boxShadow: props.$theme.lighting.shadow600,
      overflow: 'hidden',
    }),
  },
  Inner: {
    style: ({ $theme }: { $theme: Theme }) => ({
      backgroundColor: $theme.colors.backgroundPrimary,
    }),
  },
};

// popper keeps the panel inside the anchor's scroll container by default; in a narrow
// sidebar that pushes a wider panel off the left of the screen.
export const POPPER_OPTIONS = {
  modifiers: {
    preventOverflow: { enabled: true, boundariesElement: 'viewport' },
  },
};

export interface PopoverProps {
  /** The panel; `close` lets an item close it, e.g. after navigating. */
  content: (close: () => void) => ReactNode;
  /** The trigger; it gets the open/close handlers and ARIA attributes. */
  children: ReactElement;
  placement?: PopoverPlacement;
}

/**
 * A panel that opens from its trigger. Controlled so the popover id comes from
 * useId: baseui's react-uid counter differs between server and client.
 */
export function Popover({
  content,
  children,
  placement = PLACEMENT.bottomLeft,
}: PopoverProps) {
  const id = useId();
  const [isOpen, setIsOpen] = useState(false);
  const close = () => setIsOpen(false);

  return (
    <BasePopover
      id={id}
      isOpen={isOpen}
      placement={placement}
      autoFocus
      returnFocus
      focusLock
      onClick={() => setIsOpen(!isOpen)}
      onClickOutside={close}
      onEsc={close}
      content={() => content(close)}
      overrides={OVERRIDES}
      popperOptions={POPPER_OPTIONS}
    >
      {children}
    </BasePopover>
  );
}
