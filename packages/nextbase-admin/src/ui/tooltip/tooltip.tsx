import { styled } from 'baseui';
import {
  Tooltip as BaseTooltip,
  PLACEMENT,
  type TooltipPlacement,
} from 'baseui/tooltip';
import { type ReactNode, useId, useState } from 'react';

// The anchor baseui measures: a box around any child, so components that don't forward refs work too.
const Anchor = styled('span', { display: 'inline-flex' });

// Long text, such as why a message failed, wraps instead of stretching across the page.
const OVERRIDES = { Inner: { style: { maxWidth: '280px' } } };

export interface TooltipProps {
  /** What the tooltip says, e.g. a button's name. */
  content: ReactNode;
  /** Below the trigger by default. */
  placement?: TooltipPlacement;
  children: ReactNode;
}

/**
 * A tooltip on hover and keyboard focus, closed by Escape. Controlled, with an id from useId:
 * baseui's StatefulTooltip drops `id`, leaving a react-uid id that differs between server and client.
 */
export function Tooltip({
  content,
  placement = PLACEMENT.bottom,
  children,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  return (
    <BaseTooltip
      id={id}
      content={content}
      isOpen={open}
      placement={placement}
      showArrow
      overrides={OVERRIDES}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onEsc={hide}
    >
      <Anchor>{children}</Anchor>
    </BaseTooltip>
  );
}
