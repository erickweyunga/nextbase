import { styled } from 'baseui';
import { Children, type ReactNode } from 'react';

const Stack = styled('div', {
  display: 'flex',
});

const Item = styled<'span', { $first: boolean }>(
  'span',
  ({ $theme, $first }) => ({
    display: 'flex',
    borderRadius: '50%',
    // Ring in the surface colour separates overlapping avatars.
    boxShadow: `0 0 0 3px ${$theme.colors.backgroundPrimary}`,
    marginInlineStart: $first ? 0 : `-${$theme.sizing.scale300}`,
  }),
);

/** Overlapping circular avatars; later children sit on top. */
export function AvatarStack({ children }: { children: ReactNode }) {
  return (
    <Stack>
      {Children.toArray(children).map((child, index) => (
        <Item key={index} $first={index === 0}>
          {child}
        </Item>
      ))}
    </Stack>
  );
}
