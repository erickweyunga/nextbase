import { styled } from 'baseui';

/** Styles that keep an element announced by assistive technology but off screen. */
export const VISUALLY_HIDDEN_STYLE = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  borderWidth: 0,
} as const;

/** Text announced by assistive technology but not shown on screen. */
export const VisuallyHidden = styled('span', VISUALLY_HIDDEN_STYLE);
