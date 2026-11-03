import { styled } from 'baseui';
import type { ReactNode } from 'react';

const WIDE = '@media (min-width: 1024px)';

const Page = styled<'div', { $showcase: boolean }>(
  'div',
  ({ $theme, $showcase }) => ({
    display: 'grid',
    minHeight: '100dvh',
    backgroundColor: $theme.colors.backgroundPrimary,
    [WIDE]: {
      gridTemplateColumns: $showcase
        ? 'minmax(0, 1fr) minmax(400px, 38%)'
        : 'minmax(0, 1fr)',
    },
  }),
);

const Main = styled('main', ({ $theme }) => ({
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  paddingBlock: $theme.sizing.scale800,
  paddingInline: $theme.sizing.scale600,
  [WIDE]: { paddingInline: $theme.sizing.scale1200 },
}));

const Header = styled('header', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: $theme.sizing.scale600,
}));

const Content = styled('div', ({ $theme }) => ({
  display: 'grid',
  alignContent: 'center',
  flexGrow: 1,
  width: '100%',
  maxWidth: '480px',
  paddingBlock: $theme.sizing.scale1000,
}));

const Showcase = styled('aside', ({ $theme }) => ({
  display: 'none',
  [WIDE]: {
    display: 'grid',
    overflow: 'hidden',
    alignContent: 'center',
    justifyItems: 'center',
    rowGap: $theme.sizing.scale900,
    paddingBlock: $theme.sizing.scale1200,
    paddingInline: $theme.sizing.scale1000,
    backgroundColor: $theme.colors.backgroundAccent,
    color: $theme.colors.contentOnColor,
  },
}));

const Pitch = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale500,
  maxWidth: '420px',
  textAlign: 'center',
}));

const PitchTitle = styled('h2', ({ $theme }) => ({
  ...$theme.typography.HeadingMedium,
  margin: 0,
  textWrap: 'balance',
}));

const PitchText = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphMedium,
  margin: 0,
  opacity: 0.85,
}));

const Shot = styled('div', ({ $theme }) => ({
  justifySelf: 'start',
  width: '180%',
  overflow: 'hidden',
  borderRadius: $theme.borders.radius400,
  boxShadow: $theme.lighting.shadow700,
  lineHeight: 0,
}));

const Heading = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale300,
  marginBottom: $theme.sizing.scale900,
}));

const Title = styled('h1', ({ $theme }) => ({
  ...$theme.typography.HeadingLarge,
  margin: 0,
  color: $theme.colors.contentPrimary,
}));

const Subtitle = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphMedium,
  margin: 0,
  color: $theme.colors.contentTertiary,
}));

export function AuthHeading({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <Heading>
      <Title>{title}</Title>
      {children && <Subtitle>{children}</Subtitle>}
    </Heading>
  );
}

export interface AuthShowcase {
  title: string;
  text: string;
  image: { src: string; width: number; height: number };
}

export interface AuthLayoutProps {
  /** Top left, e.g. the logo linking home. */
  brand: ReactNode;
  /** Top right, e.g. a help link. */
  headerEnd?: ReactNode;
  /** The panel beside the form on wide screens; without it the form takes the whole page. */
  showcase?: AuthShowcase;
  children: ReactNode;
}

/** The frame of sign-in and account pages: brand, the form in the middle, and a showcase beside it. */
export function AuthLayout({
  brand,
  headerEnd,
  showcase,
  children,
}: AuthLayoutProps) {
  return (
    <Page $showcase={Boolean(showcase)}>
      <Main>
        <Header>
          {brand}
          {headerEnd}
        </Header>
        <Content>{children}</Content>
      </Main>
      {showcase && (
        <Showcase aria-label={showcase.title}>
          <Pitch>
            <PitchTitle>{showcase.title}</PitchTitle>
            <PitchText>{showcase.text}</PitchText>
          </Pitch>
          <Shot aria-hidden>
            <img
              src={showcase.image.src}
              alt=""
              width={showcase.image.width}
              height={showcase.image.height}
              loading="eager"
              style={{ width: '100%', height: 'auto' }}
            />
          </Shot>
        </Showcase>
      )}
    </Page>
  );
}
