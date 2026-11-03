import { styled } from 'baseui';

/**
 * A button that reads like a link, for actions in a table or list row, so rows stay quiet. Use Button for an
 * action that stands on its own.
 */
export const LinkButton = styled('button', ({ $theme }) => ({
  ...$theme.typography.ParagraphMedium,
  padding: 0,
  border: 'none',
  background: 'none',
  color: $theme.colors.contentAccent,
  textDecoration: 'underline',
  textUnderlineOffset: '3px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  ':hover:not(:disabled)': { color: $theme.colors.contentPrimary },
  ':focus-visible': {
    outline: `2px solid ${$theme.colors.borderAccent}`,
    outlineOffset: '2px',
  },
  ':disabled': {
    color: $theme.colors.contentStateDisabled,
    cursor: 'not-allowed',
  },
}));
