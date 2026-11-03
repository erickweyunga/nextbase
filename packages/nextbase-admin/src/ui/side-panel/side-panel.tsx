import { styled } from 'baseui';
import { KIND, SHAPE } from 'baseui/button';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Button } from '../button/button';
import { CloseIcon } from '../icons/index.tsx';
import { DESKTOP, useSidebar } from '../sidebar/sidebar';

const PANEL_WIDTH = '400px';

const Root = styled<'section', { $width: string }>(
  'section',
  ({ $theme, $width }) => ({
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    overflow: 'hidden',
    backgroundColor: $theme.colors.backgroundPrimary,
    outline: 'none',
    // Small screens have no room beside the content, so the panel covers it.
    position: 'fixed',
    inset: 0,
    zIndex: 3,
    [DESKTOP]: {
      // Beside a page that scrolls as a whole, it stays in view, never taller than the window.
      position: 'sticky',
      top: $theme.sizing.scale600,
      flexShrink: 0,
      width: $width,
      height: '100%',
      // The page's bottom padding, kept below it too.
      maxHeight: `calc(100dvh - 2 * ${$theme.sizing.scale600})`,
      borderRadius: $theme.borders.radius400,
    },
  }),
);

const Header = styled('header', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
  flexShrink: 0,
  paddingBlock: $theme.sizing.scale300,
  paddingInlineStart: $theme.sizing.scale600,
  paddingInlineEnd: $theme.sizing.scale300,
}));

const TitleIcon = styled('span', { display: 'inline-flex', flexShrink: 0 });

const Title = styled('h2', ({ $theme }) => ({
  ...$theme.typography.LabelLarge,
  flexGrow: 1,
  minWidth: 0,
  margin: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: $theme.colors.contentPrimary,
}));

const Body = styled('div', {
  flexGrow: 1,
  minHeight: 0,
  overflowY: 'auto',
});

const Footer = styled<'footer', { $divided: boolean }>(
  'footer',
  ({ $theme, $divided }) => ({
    ...$theme.typography.ParagraphSmall,
    display: 'grid',
    rowGap: $theme.sizing.scale300,
    flexShrink: 0,
    padding: $theme.sizing.scale600,
    borderTop: $divided
      ? `${$theme.borders.border200.borderWidth} solid ${$theme.borders.border200.borderColor}`
      : 'none',
  }),
);

export interface SidePanelProps {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  /** Pinned below the scrolling body, e.g. the panel's main action. */
  footer?: ReactNode;
  /** A line between the body and the footer. Off for footers with their own surface, e.g. a composer. */
  footerDivider?: boolean;
  /** Desktop width. Only for a panel outside SidePanelLayout, e.g. in a drawer; the layout's slot fits the default. */
  width?: string;
  /** Scrolls; runs edge to edge, so content sets its own padding. */
  children: ReactNode;
}

/**
 * A closable panel beside the page content (not a modal): title row with a
 * close button, scrolling body and pinned footer. Takes focus when it opens;
 * Escape closes it. Place it with SidePanelLayout. On small screens it covers the page.
 */
export function SidePanel({
  title,
  icon,
  onClose,
  footer,
  footerDivider = true,
  width = PANEL_WIDTH,
  children,
}: SidePanelProps) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <Root
      ref={ref}
      $width={width}
      tabIndex={-1}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <Header>
        {icon && <TitleIcon aria-hidden>{icon}</TitleIcon>}
        <Title id={titleId}>{title}</Title>
        <Button
          kind={KIND.tertiary}
          shape={SHAPE.circle}
          aria-label="Close"
          onClick={onClose}
        >
          <CloseIcon size={20} aria-hidden />
        </Button>
      </Header>
      <Body>{children}</Body>
      {footer && <Footer $divided={footerDivider}>{footer}</Footer>}
    </Root>
  );
}

const Row = styled('div', {
  display: 'flex',
  flexGrow: 1,
  minHeight: 0,
});

const Content = styled('div', ({ $theme }) => ({
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  minWidth: 0,
  minHeight: 0,
  gap: $theme.sizing.scale300,
}));

const FADE_IN = { from: { opacity: 0 }, to: { opacity: 1 } };
const FADE_OUT = { from: { opacity: 1 }, to: { opacity: 0 } };

// The slot (gap + panel) grows from nothing, so the content beside it narrows
// smoothly, while the panel, pinned to the slot's far edge, slides in with it.
const SLOT_WIDTH = (gap: string) => `calc(${PANEL_WIDTH} + ${gap})`;

const PanelSlot = styled<'div', { $closing: boolean; $flush: boolean }>(
  'div',
  ({ $theme, $closing, $flush }) => {
    const width = SLOT_WIDTH($theme.sizing.scale600);
    const grow = { from: { width: 0, opacity: 0 }, to: { width, opacity: 1 } };
    const shrink = {
      from: { width, opacity: 1 },
      to: { width: 0, opacity: 0 },
    };
    return {
      display: 'flex',
      justifyContent: 'flex-end',
      flexShrink: 0,
      // The animated opacity makes this a stacking context; keep the small-screen
      // panel, which covers the page, above the sticky header.
      position: 'relative',
      zIndex: 3,
      animationName: $closing ? FADE_OUT : FADE_IN,
      animationDuration: $theme.animation.timing300,
      animationTimingFunction: $theme.animation.easeInOutCurve,
      animationFillMode: 'both',
      [DESKTOP]: {
        width,
        // Clip, not hidden: hidden would make this a scroll container, and the panel inside couldn't stick.
        overflow: 'clip',
        // Starts level with a large PageHeader's controls, beside it rather than below.
        paddingBlockStart: $flush ? 0 : $theme.sizing.scale600,
        animationName: $closing ? shrink : grow,
      },
      '@media (prefers-reduced-motion: reduce)': { animationDuration: '1ms' },
    };
  },
);

const PanelOpenContext = createContext(false);

/** Whether the surrounding SidePanelLayout has a panel open; false outside one. */
export function useSidePanelOpen() {
  return useContext(PanelOpenContext);
}

export interface SidePanelLayoutProps {
  /** Usually a <SidePanel />, or nothing while it is closed. */
  panel?: ReactNode;
  /** Starts the panel level with the content's top, for content that is a card of its own rather than a page header. */
  flush?: boolean;
  children: ReactNode;
}

/**
 * Page content with an optional SidePanel to its right, for a list page inside
 * `PageContent wide`. The panel animates in and out as `panel` is set and cleared.
 */
export function SidePanelLayout({
  panel,
  flush = false,
  children,
}: SidePanelLayoutProps) {
  // An open panel takes the width the area's menu would use, so the menu folds to icons meanwhile.
  const { setPanelMadeRoom } = useSidebar();
  const open = Boolean(panel);
  useEffect(() => {
    setPanelMadeRoom(open);
    return () => setPanelMadeRoom(false);
  }, [open, setPanelMadeRoom]);

  // The last panel shown, kept on screen while it animates out.
  const [closing, setClosing] = useState<ReactNode>(null);
  const [previous, setPrevious] = useState<ReactNode>(panel);
  if (panel !== previous) {
    setClosing(panel ? null : previous);
    setPrevious(panel);
  }
  const shown = panel || closing;

  return (
    <Row>
      <Content>
        <PanelOpenContext.Provider value={open}>
          {children}
        </PanelOpenContext.Provider>
      </Content>
      {shown && (
        <PanelSlot
          $closing={!panel}
          $flush={flush}
          onAnimationEnd={(event) => {
            if (!panel && event.target === event.currentTarget)
              setClosing(null);
          }}
        >
          {shown}
        </PanelSlot>
      )}
    </Row>
  );
}
