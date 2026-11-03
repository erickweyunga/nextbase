import { styled, type Theme } from 'baseui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import type { StyleObject } from 'styletron-react';
import { Link as NextLink } from '../navigation';

const rootStyles = ({ $theme }: { $theme: Theme }): StyleObject => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale600,
  boxSizing: 'border-box',
  width: '100%',
  paddingBlock: $theme.sizing.scale500,
  paddingInline: $theme.sizing.scale600,
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: $theme.borders.border300.borderColor,
  borderRadius: $theme.borders.radius400,
  backgroundColor: $theme.colors.backgroundPrimary,
  color: $theme.colors.contentPrimary,
  font: 'inherit',
  textAlign: 'start',
  textDecoration: 'none',
  cursor: 'pointer',
  transitionProperty: 'border-color',
  transitionDuration: $theme.animation.timing200,
  ':hover': {
    borderColor: $theme.colors.borderSelected,
  },
  ':focus-visible': {
    outline: `2px solid ${$theme.colors.borderAccent}`,
    outlineOffset: '2px',
  },
  ':disabled': {
    cursor: 'not-allowed',
    borderColor: $theme.borders.border200.borderColor,
    color: $theme.colors.contentStateDisabled,
  },
});

const ButtonRoot = styled('button', rootStyles);
const LinkRoot = styled(NextLink, rootStyles);

const Media = styled('span', {
  display: 'inline-flex',
  flexShrink: 0,
});

const Text = styled('span', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale0,
}));

const Title = styled('span', ({ $theme }) => $theme.typography.LabelMedium);

const Description = styled('span', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  color: $theme.colors.contentTertiary,
}));

interface CardContent {
  title: ReactNode;
  description?: ReactNode;
  /** Decorative visual shown before the text, e.g. a logo. */
  media?: ReactNode;
}

export type OptionCardProps = CardContent &
  (
    | ({ href?: undefined } & Omit<
        ComponentPropsWithoutRef<'button'>,
        keyof CardContent | 'children'
      >)
    | ({ href: string } & Omit<
        ComponentPropsWithoutRef<typeof NextLink>,
        keyof CardContent | 'children' | 'href'
      >)
  );

/** A large clickable card: a button for picking an option, or a link when given `href`. */
export function OptionCard({
  title,
  description,
  media,
  ...props
}: OptionCardProps) {
  const content = (
    <>
      {media && <Media aria-hidden>{media}</Media>}
      <Text>
        <Title>{title}</Title>
        {description && <Description>{description}</Description>}
      </Text>
    </>
  );

  return props.href === undefined ? (
    <ButtonRoot type="button" {...props}>
      {content}
    </ButtonRoot>
  ) : (
    <LinkRoot {...props}>{content}</LinkRoot>
  );
}
