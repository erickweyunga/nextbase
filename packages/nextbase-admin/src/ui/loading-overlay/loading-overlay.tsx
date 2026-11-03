import { styled } from 'baseui';
import { SIZE, Spinner } from 'baseui/spinner';
import { createPortal } from 'react-dom';
import { VisuallyHidden } from '../visually-hidden';

const Backdrop = styled('div', ({ $theme }) => ({
  position: 'fixed',
  inset: 0,
  // Above baseui's layers, so it also covers open menus and dialogs.
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'rgba(255, 255, 255, 0.8)',
  cursor: 'wait',
  animationName: {
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
  animationDuration: $theme.animation.timing200,
  animationFillMode: 'both',
}));

export interface LoadingOverlayProps {
  /** Whether to show it. */
  visible: boolean;
  /** Read by screen readers, e.g. "Signing out". */
  label: string;
}

/** Covers the whole screen with a spinner while something blocking happens, such as signing out. */
export function LoadingOverlay({ visible, label }: LoadingOverlayProps) {
  if (!visible || typeof document === 'undefined') return null;
  return createPortal(
    <Backdrop role="status" aria-live="polite">
      <Spinner $size={SIZE.large} />
      <VisuallyHidden>{label}</VisuallyHidden>
    </Backdrop>,
    document.body,
  );
}
