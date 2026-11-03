import { primitiveDarkColors, primitiveLightColors } from 'baseui/tokens';

/**
 * `scrollbar-color` for the root element; every scroll area inherits it. A light
 * gray300 thumb on a transparent track, chosen to stay quiet over strict 3:1 contrast.
 */
export const SCROLLBAR_COLOR = `${primitiveLightColors.gray300} transparent`;

export const SCROLLBAR_COLOR_DARK = `${primitiveDarkColors.gray400Dark} transparent`;
