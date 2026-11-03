import { styled, type Theme } from 'baseui';
import { KIND, SHAPE } from 'baseui/button';
import { ANCHOR, SIZE as DRAWER_SIZE } from 'baseui/drawer';
import { type Item, Navigation, StyledNavLink } from 'baseui/side-navigation';
import { expandBorderStyles } from 'baseui/styles';
import { PLACEMENT, Tooltip } from 'baseui/tooltip';
import {
  type ComponentProps,
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { StyleObject } from 'styletron-react';
import { Button } from '../button/button';
import { Drawer } from '../drawer/drawer';
import {
  ChevronLeftIcon,
  ExpandMoreIcon,
  LeftPanelCloseIcon,
  LeftPanelOpenIcon,
  MenuIcon,
  SearchIcon,
} from '../icons/index.tsx';
import { Input } from '../input/input';
import { Link, usePathname } from '../navigation';
import {
  SIDEBAR_COLLAPSED_COOKIE,
  SIDEBAR_PANEL_COLLAPSED_COOKIE,
} from '../sidebar-cookie';
import { VisuallyHidden } from '../visually-hidden/visually-hidden';

// Below this width the navigation moves into a drawer behind a menu button.
const DESKTOP_QUERY = '(min-width: 960px)';
/** Media query for the desktop layout (rail and panel beside the page), for styles that differ from the mobile drawer layout. */
export const DESKTOP = `@media screen and ${DESKTOP_QUERY}`;

const RAIL_WIDTH = '240px';
const COLLAPSED_RAIL_WIDTH = '74px';
const PANEL_WIDTH = '280px';
const COLLAPSED_PANEL_WIDTH = '65px';
const ICON_SIZE = '20px';
/** An icon-only item: the icon plus the item's inline padding on both sides. */
const COLLAPSED_ITEM_SIZE = ($theme: Theme) =>
  `calc(${ICON_SIZE} + 2 * ${$theme.sizing.scale400})`;
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/** Collapse and expand: widths, paddings and the turning chevrons move together. */
const resizeTransition = ($theme: Theme, property: string): StyleObject => ({
  transitionProperty: property,
  transitionDuration: $theme.animation.timing200,
  transitionTimingFunction: $theme.animation.easeInOutCurve,
  [REDUCED_MOTION]: { transitionDuration: '0s' },
});

const fadeTransition = ($theme: Theme): StyleObject => ({
  transitionProperty: 'opacity',
  transitionDuration: $theme.animation.timing200,
  transitionTimingFunction: $theme.animation.easeOutCurve,
  [REDUCED_MOTION]: { transitionDuration: '0s' },
});

// A chevron drawn once and turned half a circle, so it turns rather than swaps.
const Turn = styled<'span', { $turned: boolean }>(
  'span',
  ({ $theme, $turned }) => ({
    display: 'inline-flex',
    transform: $turned ? 'rotate(180deg)' : 'none',
    ...resizeTransition($theme, 'transform'),
  }),
);

export interface SidebarItem {
  title: string;
  /** Route the item links to. It stays active on nested routes, e.g. "/settings" on "/settings/billing", unless a more specific item in the same list matches. */
  href: string;
  /**
   * The part of the app the item stands for, when it links to a page inside it: e.g. href "/settings/profile" with
   * section "/settings" stays active anywhere in settings. Defaults to href.
   */
  section?: string;
  icon?: ReactNode;
  /** A count shown beside the title, e.g. unread conversations; nothing shows for 0. */
  badge?: number;
  items?: SidebarItem[];
}

/** A labelled section of items, e.g. "Account". */
export interface SidebarGroup {
  label: string;
  icon?: ReactNode;
  /** Render the label as a button that shows and hides the items. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  items: SidebarItem[];
}

export type SidebarEntry = SidebarItem | SidebarGroup;

type Variant = 'rail' | 'panel';

export interface SidebarState {
  /** The desktop rail is showing icons only. */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Below the desktop breakpoint, where navigation lives in a drawer. */
  isMobile: boolean;
  /** Collapses or expands the rail on desktop; opens or closes the drawer on mobile. */
  toggle: () => void;
  /** Whether this rail instance can collapse: true for the desktop rail only. */
  collapsible: boolean;
  /** The desktop panel is showing icons only. */
  panelCollapsed: boolean;
  setPanelCollapsed: (collapsed: boolean) => void;
  /**
   * Collapses the panel for a while without changing the saved choice, e.g. while a side
   * panel needs the room. Toggling the panel by hand ends it.
   */
  setPanelMadeRoom: (makeRoom: boolean) => void;
}

const SidebarContext = createContext<SidebarState>({
  collapsed: false,
  setCollapsed: () => {},
  isMobile: false,
  toggle: () => {},
  collapsible: false,
  panelCollapsed: false,
  setPanelCollapsed: () => {},
  setPanelMadeRoom: () => {},
});

/** Sidebar state for anything inside SidebarLayout, e.g. a toggle in a page header or content that adapts to the icon rail. */
export function useSidebar() {
  return useContext(SidebarContext);
}

// Rail and panel items differ in type and fills; footer links follow the container they sit in.
const VariantContext = createContext<Variant>('rail');

// Lets a nested SidebarPanelLayout hand its panel to SidebarLayout's mobile drawer.
const PanelRegistryContext = createContext<(panel: ReactNode) => void>(
  () => {},
);

function subscribeToViewport(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Below the desktop breakpoint. The server and hydration assume desktop, matching the CSS-driven first paint. */
function useIsMobile() {
  return useSyncExternalStore(
    subscribeToViewport,
    () => !window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

function saveCookie(name: string, value: boolean) {
  // biome-ignore lint/suspicious/noDocumentCookie: one synchronous write per toggle; the Cookie Store API is async and newer.
  document.cookie = `${name}=${value}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

function isActiveRoute(href: string, pathname: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface ItemStyleProps {
  $theme: Theme;
  $active?: boolean;
  $level?: number;
  $collapsed: boolean;
  $variant: Variant;
}

/** Shared look of rail and panel items, whether baseui nav links or our own buttons. */
function itemStyles({
  $theme,
  $active = false,
  $level = 1,
  $collapsed,
  $variant,
}: ItemStyleProps): StyleObject {
  const { colors, sizing, borders, typography, animation } = $theme;
  const activeFill =
    $variant === 'rail' ? colors.backgroundPrimary : colors.backgroundSecondary;
  const hoverFill =
    $variant === 'rail'
      ? colors.backgroundTertiary
      : colors.backgroundSecondary;

  return {
    ...($variant === 'rail'
      ? typography.LabelMedium
      : typography.ParagraphMedium),
    // One row height for rail and panel, so their items line up side by side.
    lineHeight: typography.LabelMedium.lineHeight,
    display: 'flex',
    alignItems: 'center',
    boxSizing: 'border-box',
    // Icon-only, a square around the icon, so the icon is centred in its highlight.
    // Always left-anchored (no auto margins), so nothing re-centres mid-animation;
    // the narrow strips are sized so the square lands in their middle.
    width: $collapsed ? `min(100%, ${COLLAPSED_ITEM_SIZE($theme)})` : '100%',
    margin: 0,
    transitionProperty: 'width, padding-left, background-color, color',
    transitionDuration: [
      animation.timing200,
      animation.timing200,
      animation.timing150,
      animation.timing150,
    ].join(),
    transitionTimingFunction: [
      animation.easeInOutCurve,
      animation.easeInOutCurve,
      animation.easeOutCurve,
      animation.easeOutCurve,
    ].join(),
    [REDUCED_MOTION]: { transitionDuration: '0s' },
    // Undo baseui's active bar and gradient.
    borderLeftWidth: 0,
    borderRightWidth: 0,
    backgroundImage: 'none',
    borderRadius: borders.radius300,
    paddingTop: sizing.scale300,
    paddingBottom: sizing.scale300,
    // Icons keep their position while the rail collapses, so nothing jumps.
    // Collapsed, the icon is centred in whatever width the strip leaves (the rail's is under a full square).
    paddingLeft: $collapsed
      ? `calc((min(100%, ${COLLAPSED_ITEM_SIZE($theme)}) - ${ICON_SIZE}) / 2)`
      : `calc(${sizing.scale400} + ${sizing.scale600} * ${$level - 1})`,
    paddingRight: sizing.scale400,
    color: colors.contentPrimary,
    backgroundColor: $active ? activeFill : 'transparent',
    cursor: 'pointer',
    textAlign: 'start',
    ':hover': {
      color: colors.contentPrimary,
      backgroundColor: $active ? activeFill : hoverFill,
    },
    ':focus': {
      color: colors.contentPrimary,
    },
  };
}

const ItemTitle = styled('span', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale500,
  width: '100%',
  minWidth: 0,
  whiteSpace: 'nowrap',
}));

const ItemIcon = styled('span', {
  position: 'relative',
  display: 'inline-flex',
  flexShrink: 0,
});

const badgeStyles = ($theme: Theme): StyleObject => ({
  ...$theme.typography.LabelXSmall,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxSizing: 'border-box',
  minWidth: $theme.sizing.scale700,
  height: $theme.sizing.scale700,
  paddingInline: $theme.sizing.scale100,
  borderRadius: $theme.sizing.scale700,
  backgroundColor: $theme.colors.backgroundInversePrimary,
  color: $theme.colors.contentInversePrimary,
});

const ItemBadge = styled<'span', { $faded: boolean }>(
  'span',
  ({ $theme, $faded }) => ({
    ...badgeStyles($theme),
    flexShrink: 0,
    marginInlineStart: 'auto',
    opacity: $faded ? 0 : 1,
    ...fadeTransition($theme),
  }),
);

// In the icon rail the count sits on the icon's corner, as the title's badge fades with it.
const IconBadge = styled('span', ({ $theme }) => ({
  ...badgeStyles($theme),
  position: 'absolute',
  top: `calc(-1 * ${$theme.sizing.scale300})`,
  insetInlineStart: `calc(${ICON_SIZE} - ${$theme.sizing.scale300})`,
  minWidth: $theme.sizing.scale600,
  height: $theme.sizing.scale600,
  fontSize: '10px',
}));

const badgeText = (badge: number) => (badge > 99 ? '99+' : String(badge));

const ItemText = styled<'span', { $faded: boolean }>(
  'span',
  ({ $theme, $faded }) => ({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    opacity: $faded ? 0 : 1,
    ...fadeTransition($theme),
  }),
);

const TOOLTIP_POPPER_OPTIONS = {
  modifiers: {
    preventOverflow: {
      enabled: true,
      padding: 0,
      boundariesElement: 'viewport',
    },
    flip: { boundariesElement: 'viewport' },
  },
};

function ItemLabel({
  title,
  icon,
  badge = 0,
}: {
  title: string;
  icon?: ReactNode;
  badge?: number;
}) {
  const { collapsed } = useSidebar();
  const tooltipId = useId();
  const iconRef = useRef<HTMLSpanElement>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  // In the icon rail the title shows as a tooltip while the whole item is
  // hovered or focused, so keyboard users see it too. Escape dismisses it.
  useEffect(() => {
    const target = iconRef.current?.closest('a, button');
    if (!collapsed || !(target instanceof HTMLElement)) return;

    const show = () => setTooltipOpen(true);
    const hide = () => setTooltipOpen(false);
    const hideOnEscape = (event: KeyboardEvent) =>
      event.key === 'Escape' && hide();
    target.addEventListener('mouseenter', show);
    target.addEventListener('mouseleave', hide);
    target.addEventListener('focus', show);
    target.addEventListener('blur', hide);
    target.addEventListener('keydown', hideOnEscape);
    return () => {
      target.removeEventListener('mouseenter', show);
      target.removeEventListener('mouseleave', hide);
      target.removeEventListener('focus', show);
      target.removeEventListener('blur', hide);
      target.removeEventListener('keydown', hideOnEscape);
    };
  }, [collapsed]);

  // The title only fades in the icon rail, so it stays the item's accessible name.
  const label = (
    <ItemTitle>
      {(icon || collapsed) && (
        <ItemIcon ref={iconRef} aria-hidden>
          {icon ?? title.charAt(0)}
          {collapsed && badge > 0 && <IconBadge>{badgeText(badge)}</IconBadge>}
        </ItemIcon>
      )}
      <ItemText $faded={collapsed}>{title}</ItemText>
      {badge > 0 && (
        <ItemBadge $faded={collapsed}>{badgeText(badge)}</ItemBadge>
      )}
    </ItemTitle>
  );

  if (!collapsed) return label;

  return (
    <Tooltip
      id={tooltipId}
      content={badge > 0 ? `${title} (${badgeText(badge)})` : title}
      isOpen={tooltipOpen}
      onEsc={() => setTooltipOpen(false)}
      placement={PLACEMENT.right}
      showArrow
      // The narrow rail clips overflow, so popper would squeeze the tooltip back over the icon.
      popperOptions={TOOLTIP_POPPER_OPTIONS}
    >
      {label}
    </Tooltip>
  );
}

function flattenItems(items: SidebarItem[]): SidebarItem[] {
  return items.flatMap((item) => [
    item,
    ...(item.items ? flattenItems(item.items) : []),
  ]);
}

function toNavItems(items: SidebarItem[]): Item[] {
  return items.map(({ title, href, icon, badge, items: children }) => ({
    itemId: href,
    title: <ItemLabel title={title} icon={icon} badge={badge} />,
    subNav: children && toNavItems(children),
  }));
}

function NavLink({
  $as,
  $active,
  ...props
}: ComponentProps<typeof StyledNavLink> & { $active?: boolean }) {
  return (
    <StyledNavLink
      {...props}
      $as={$as === 'a' ? Link : $as}
      aria-current={$active ? 'page' : undefined}
    />
  );
}

interface NavListProps {
  items: SidebarItem[];
  variant: Variant;
  /** Names the list as a group, e.g. after its section label. */
  labelledBy?: string;
}

/** baseui's Navigation with our links and item look; one landmark is provided by the caller. */
function NavList({ items, variant, labelledBy }: NavListProps) {
  const pathname = usePathname();
  const { collapsed } = useSidebar();
  // Only the most specific match is active, so "/customers" is not lit on "/customers/segments"
  // when the list has both.
  const sectionOf = (item: SidebarItem) => item.section ?? item.href;
  const activeHref = flattenItems(items)
    .filter((item) => isActiveRoute(sectionOf(item), pathname))
    .sort((a, b) => sectionOf(b).length - sectionOf(a).length)[0]?.href;

  return (
    <Navigation
      items={toNavItems(items)}
      activeItemId={activeHref ?? ''}
      activePredicate={(item, activeItemId) =>
        !!item.itemId && item.itemId === activeItemId
      }
      overrides={{
        Root: {
          props: {
            $as: 'div',
            role: labelledBy ? 'group' : undefined,
            'aria-labelledby': labelledBy,
          },
        },
        // baseui skips SubNavContainer overrides on the top-level list, so items space themselves.
        NavItemContainer: {
          style: ({ $theme }) => ({
            ':not(:first-child)': { marginTop: $theme.sizing.scale100 },
          }),
        },
        SubNavContainer: {
          style: ({ $theme }) => ({ marginTop: $theme.sizing.scale100 }),
        },
        NavLink: { component: NavLink },
        NavItem: {
          style: ({ $theme, $active, $level }) =>
            itemStyles({
              $theme,
              $active,
              $level,
              $collapsed: collapsed,
              $variant: variant,
            }),
        },
      }}
    />
  );
}

interface SidebarSection {
  label?: string;
  icon?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  items: SidebarItem[];
}

/** Consecutive ungrouped items form an unlabelled section. */
function toSections(entries: SidebarEntry[]): SidebarSection[] {
  const sections: SidebarSection[] = [];
  for (const entry of entries) {
    if ('label' in entry) {
      sections.push(entry);
      continue;
    }
    const last = sections.at(-1);
    if (last && last.label === undefined) last.items.push(entry);
    else sections.push({ items: [entry] });
  }
  return sections;
}

const SectionRoot = styled<'div', { $collapsed: boolean; $first: boolean }>(
  'div',
  ({ $theme, $collapsed, $first }) => ({
    ...($first
      ? {}
      : $collapsed
        ? {
            // Group labels become a divider in the icon rail.
            ...expandBorderStyles($theme.borders.border200),
            borderRightStyle: 'none',
            borderBottomStyle: 'none',
            borderLeftStyle: 'none',
            marginBlockStart: $theme.sizing.scale300,
            paddingBlockStart: $theme.sizing.scale300,
          }
        : { marginBlockStart: $theme.sizing.scale100 }),
  }),
);

const GroupLabel = styled('div', ({ $theme }) => ({
  ...$theme.typography.LabelXSmall,
  color: $theme.colors.contentTertiary,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  paddingBlock: $theme.sizing.scale300,
  paddingInlineEnd: $theme.sizing.scale400,
}));

// Keeps its expanded layout when collapsed: the label and chevron fade and the
// narrowing strip clips them, so the icon stays put instead of re-centring.
const GroupToggle = styled('button', ({ $theme }) => ({
  ...$theme.typography.LabelLarge,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale500,
  boxSizing: 'border-box',
  width: '100%',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  marginBlockEnd: $theme.sizing.scale100,
  paddingBlock: $theme.sizing.scale200,
  paddingInline: 0,
  borderWidth: 0,
  borderRadius: $theme.borders.radius300,
  backgroundColor: 'transparent',
  color: $theme.colors.contentPrimary,
  cursor: 'pointer',
  textAlign: 'start',
  ':hover > span:last-child': {
    backgroundColor: $theme.colors.backgroundSecondary,
  },
  ':focus-visible': {
    outline: `3px solid ${$theme.colors.borderAccent}`,
    outlineOffset: '-3px',
  },
}));

const GroupToggleText = styled<'span', { $faded: boolean }>(
  'span',
  ({ $theme, $faded }) => ({
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    opacity: $faded ? 0 : 1,
    ...fadeTransition($theme),
  }),
);

const GroupChevron = styled<'span', { $faded: boolean }>(
  'span',
  ({ $theme, $faded }) => ({
    display: 'inline-flex',
    flexShrink: 0,
    padding: $theme.sizing.scale100,
    borderRadius: $theme.borders.radius200,
    opacity: $faded ? 0 : 1,
    transitionProperty: 'background-color, opacity',
    transitionDuration: `${$theme.animation.timing150}, ${$theme.animation.timing200}`,
    transitionTimingFunction: $theme.animation.easeOutCurve,
    [REDUCED_MOTION]: { transitionDuration: '0s' },
  }),
);

function NavSection({
  label,
  icon,
  collapsible,
  defaultOpen = true,
  items,
  first,
  variant,
}: SidebarSection & { first: boolean; variant: Variant }) {
  const { collapsed } = useSidebar();
  const pathname = usePathname();
  const labelId = useId();
  const listId = useId();
  const [open, setOpen] = useState(
    () =>
      defaultOpen ||
      flattenItems(items).some((item) =>
        isActiveRoute(item.section ?? item.href, pathname),
      ),
  );
  // A toggle stays in icon mode as its icon; a plain label, or a toggle without an icon, gives way to a divider.
  const showToggle = Boolean(label && collapsible && (icon || !collapsed));

  let heading: ReactNode = null;
  if (showToggle) {
    heading = (
      <GroupToggle
        id={labelId}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        {icon && <ItemIcon aria-hidden>{icon}</ItemIcon>}
        <GroupToggleText $faded={collapsed}>{label}</GroupToggleText>
        <GroupChevron aria-hidden $faded={collapsed}>
          <Turn $turned={open}>
            <ExpandMoreIcon size={16} />
          </Turn>
        </GroupChevron>
      </GroupToggle>
    );
  } else if (label && collapsed)
    heading = <VisuallyHidden id={labelId}>{label}</VisuallyHidden>;
  else if (label) heading = <GroupLabel id={labelId}>{label}</GroupLabel>;

  return (
    <SectionRoot $collapsed={collapsed && !showToggle} $first={first}>
      {heading}
      <div id={listId} hidden={showToggle ? !open : undefined}>
        <NavList
          items={items}
          variant={variant}
          labelledBy={label ? labelId : undefined}
        />
      </div>
    </SectionRoot>
  );
}

function NavSections({
  items,
  variant,
}: {
  items: SidebarEntry[];
  variant: Variant;
}) {
  return toSections(items).map((section, index) => (
    <NavSection
      key={section.label ?? index}
      {...section}
      first={index === 0}
      variant={variant}
    />
  ));
}

const RailRoot = styled<'div', { $collapsed: boolean }>(
  'div',
  ({ $theme, $collapsed }) => ({
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    width: $collapsed ? COLLAPSED_RAIL_WIDTH : RAIL_WIDTH,
    height: '100%',
    paddingBlock: $theme.sizing.scale650,
    paddingInlineStart: $theme.sizing.scale700,
    paddingInlineEnd: $theme.sizing.scale400,
    overflowX: 'hidden',
    ...resizeTransition($theme, 'width'),
  }),
);

// Wrapping, rather than switching direction, keeps the toggle on the rail's edge as it collapses.
const RailHeader = styled('div', ({ $theme }) => ({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  rowGap: $theme.sizing.scale300,
  flexShrink: 0,
  paddingBlockEnd: $theme.sizing.scale500,
}));

const TOGGLE_SLOT_WIDTH = '40px';

// Square, so the rail's and the panel's headers are the same height and their first items line up.
const ToggleSlot = styled('div', {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: TOGGLE_SLOT_WIDTH,
  height: TOGGLE_SLOT_WIDTH,
});

const RailBody = styled('nav', ({ $theme }) => ({
  flexGrow: 1,
  minHeight: 0,
  overflowY: 'auto',
  // A full-width scrollbar would squeeze the icons in the 64px rail.
  scrollbarWidth: 'thin',
  paddingBlockEnd: $theme.sizing.scale500,
}));

const RailFooter = styled('div', ({ $theme }) => ({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  rowGap: $theme.sizing.scale100,
  flexShrink: 0,
}));

export interface SidebarProps {
  /** Links, or labelled groups of links, at the top of the rail. */
  items?: SidebarEntry[];
  /** Accessible name of the navigation landmark. */
  label?: string;
  /** Top of the rail, e.g. the product logo. */
  header?: ReactNode;
  /** Pinned to the bottom, e.g. a SidebarButton, a SidebarLink and the account. */
  footer?: ReactNode;
}

/**
 * The app's main navigation rail; marks the item for the current route. Inside
 * SidebarLayout on desktop it collapses to icons only.
 */
export function Sidebar({
  items = [],
  label = 'Main',
  header,
  footer,
}: SidebarProps) {
  const { collapsed, setCollapsed, collapsible } = useSidebar();

  return (
    <RailRoot $collapsed={collapsed}>
      {(header || collapsible) && (
        <RailHeader>
          {header}
          {collapsible && (
            <ToggleSlot>
              <Button
                kind={KIND.tertiary}
                shape={SHAPE.circle}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!collapsed}
                aria-keyshortcuts="Meta+B Control+B"
                onClick={() => setCollapsed(!collapsed)}
              >
                <Turn $turned={collapsed}>
                  <ChevronLeftIcon size={20} aria-hidden />
                </Turn>
              </Button>
            </ToggleSlot>
          )}
        </RailHeader>
      )}
      <RailBody aria-label={label}>
        <NavSections items={items} variant="rail" />
      </RailBody>
      {footer && <RailFooter>{footer}</RailFooter>}
    </RailRoot>
  );
}

type ActionProps = Omit<ItemStyleProps, '$theme'> & { $accent: boolean };

function actionStyles({
  $accent,
  ...props
}: ActionProps & { $theme: Theme }): StyleObject {
  const { colors } = props.$theme;
  const base = itemStyles(props);
  const color = $accent ? colors.contentAccent : colors.contentPrimary;
  const hover = base[':hover'];

  return {
    font: 'inherit',
    ...base,
    borderWidth: 0,
    textDecoration: 'none',
    color,
    ':hover': { ...(typeof hover === 'object' ? hover : undefined), color },
    ':focus': { color },
    ':focus-visible': {
      outline: `3px solid ${colors.borderAccent}`,
      outlineOffset: '-3px',
    },
  };
}

const ActionLink = styled<typeof Link, ActionProps>(Link, actionStyles);
const ActionButton = styled<'button', ActionProps>('button', actionStyles);

export type SidebarLinkProps = Omit<SidebarItem, 'items'> & {
  /** Highlight as a call to action, e.g. "Create a new workspace". */
  accent?: boolean;
};

/** A single link outside the item list, e.g. "Settings" in the rail footer or secondary links in a panel footer. */
export function SidebarLink({
  title,
  href,
  section,
  icon,
  accent = false,
}: SidebarLinkProps) {
  const pathname = usePathname();
  const { collapsed } = useSidebar();
  const variant = useContext(VariantContext);
  const active = isActiveRoute(section ?? href, pathname);

  return (
    <ActionLink
      href={href}
      aria-current={active ? 'page' : undefined}
      $active={active}
      $collapsed={collapsed}
      $variant={variant}
      $accent={accent}
    >
      <ItemLabel title={title} icon={icon} />
    </ActionLink>
  );
}

export type SidebarButtonProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  'children' | 'title'
> & {
  title: string;
  icon?: ReactNode;
  /** Highlight as a call to action, e.g. "Get help". */
  accent?: boolean;
};

/** An item that runs an action instead of navigating, e.g. opening a dialog. */
export function SidebarButton({
  title,
  icon,
  accent = false,
  ...props
}: SidebarButtonProps) {
  const { collapsed } = useSidebar();
  const variant = useContext(VariantContext);

  return (
    <ActionButton
      type="button"
      $collapsed={collapsed}
      $variant={variant}
      $accent={accent}
      {...props}
    >
      <ItemLabel title={title} icon={icon} />
    </ActionButton>
  );
}

export interface SidebarActionButtonProps {
  title: string;
  icon: ReactNode;
  onClick: () => void;
}

/** A panel's main action, e.g. "Compose": a full-width primary button with its title, or its icon while collapsed. */
export function SidebarActionButton({
  title,
  icon,
  onClick,
}: SidebarActionButtonProps) {
  const { collapsed } = useSidebar();
  return collapsed ? (
    <Button
      kind={KIND.primary}
      shape={SHAPE.square}
      aria-label={title}
      onClick={onClick}
    >
      {icon}
    </Button>
  ) : (
    <Button
      kind={KIND.primary}
      onClick={onClick}
      overrides={{ BaseButton: { style: { width: '100%' } } }}
    >
      {title}
    </Button>
  );
}

const PanelSearchArea = styled('div', ({ $theme }) => ({
  marginTop: $theme.sizing.scale300,
}));

export interface SidebarPanelSearchProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
}

export function SidebarPanelSearch({
  value,
  onChange,
  label,
  placeholder = 'Search',
}: SidebarPanelSearchProps) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return (
    <PanelSearchArea>
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        aria-label={label}
        clearOnEscape
        startEnhancer={<SearchIcon size={16} aria-hidden />}
      />
    </PanelSearchArea>
  );
}

const PanelCard = styled<'div', { $collapsed: boolean }>(
  'div',
  ({ $theme, $collapsed }) => ({
    ...expandBorderStyles($theme.borders.border100),
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    width: $collapsed ? COLLAPSED_PANEL_WIDTH : PANEL_WIDTH,
    height: '100%',
    overflow: 'hidden',
    borderRadius: $theme.borders.radius400,
    backgroundColor: $theme.colors.backgroundPrimary,
    ...resizeTransition($theme, 'width'),
  }),
);

// The toggle moves between the top-right corner and the centre through padding in
// percent of the narrowing card, which animates; switching alignment would jump.
const PanelHeader = styled<'div', { $collapsed: boolean }>(
  'div',
  ({ $theme, $collapsed }) => ({
    flexShrink: 0,
    // With the aside's padding, this matches the rail's top padding; the card's border takes the rest.
    paddingBlockStart: `calc(${$theme.sizing.scale300} - ${$theme.borders.border100.borderWidth})`,
    paddingInlineStart: $collapsed
      ? `calc(50% - ${TOGGLE_SLOT_WIDTH} / 2)`
      : `calc(100% - ${TOGGLE_SLOT_WIDTH} - ${$theme.sizing.scale400})`,
    ...resizeTransition($theme, 'padding'),
  }),
);

const PanelContents = styled('div', {
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  minHeight: 0,
});

// Icon-only, the padding splits what the narrow strip leaves around an item evenly, centring it.
const panelSectionPadding = ({
  $theme,
  $collapsed,
}: {
  $theme: Theme;
  $collapsed: boolean;
}): StyleObject => ({
  paddingBlock: $theme.sizing.scale500,
  paddingInline: $collapsed
    ? `calc((${COLLAPSED_PANEL_WIDTH} - ${$theme.borders.border200.borderWidth} - ${COLLAPSED_ITEM_SIZE($theme)}) / 2)`
    : $theme.sizing.scale500,
  ...resizeTransition($theme, 'padding'),
});

const PanelBody = styled<'nav', { $collapsed: boolean }>('nav', (props) => ({
  ...panelSectionPadding(props),
  flexGrow: 1,
  minHeight: 0,
  overflowX: 'hidden',
  overflowY: 'auto',
  scrollbarWidth: 'thin',
}));

const PanelAction = styled<'div', { $collapsed: boolean }>('div', (props) => ({
  ...panelSectionPadding(props),
  paddingBlockEnd: 0,
  flexShrink: 0,
}));

const PanelFooter = styled<'div', { $collapsed: boolean }>('div', (props) => ({
  ...panelSectionPadding(props),
  flexShrink: 0,
}));

export interface SidebarPanelProps {
  /** Links, or labelled groups of links; set `collapsible` on a group to let it open and close. */
  items: SidebarEntry[];
  /** Accessible name of the panel's navigation landmark, e.g. "Settings". */
  label: string;
  /** Pinned to the bottom, e.g. secondary links and the app version. */
  footer?: ReactNode;
  /** Above the links, the area's main action; usually a SidebarActionButton. */
  action?: ReactNode;
}

function PanelToggleIcon({ collapsed }: { collapsed: boolean }) {
  return collapsed ? (
    <LeftPanelOpenIcon size={20} aria-hidden />
  ) : (
    <LeftPanelCloseIcon size={20} aria-hidden />
  );
}

function PanelToggle({ controls }: { controls: string }) {
  const { panelCollapsed, setPanelCollapsed } = useSidebar();
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const label = panelCollapsed ? 'Expand menu' : 'Collapse menu';
  const show = () => setTooltipOpen(true);
  const hide = () => setTooltipOpen(false);

  return (
    <ToggleSlot>
      <Tooltip
        id={tooltipId}
        content={label}
        isOpen={tooltipOpen}
        placement={panelCollapsed ? PLACEMENT.right : PLACEMENT.left}
        showArrow
        popperOptions={TOOLTIP_POPPER_OPTIONS}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onEsc={hide}
      >
        <Button
          kind={KIND.tertiary}
          shape={SHAPE.circle}
          aria-label={label}
          aria-expanded={!panelCollapsed}
          aria-controls={controls}
          onClick={() => setPanelCollapsed(!panelCollapsed)}
        >
          <PanelToggleIcon collapsed={panelCollapsed} />
        </Button>
      </Tooltip>
    </ToggleSlot>
  );
}

/**
 * Secondary navigation for the current area of the app, shown between the rail
 * and the page. On desktop it collapses to icons only. Use SidebarLink and
 * SidebarButton in `footer` so they collapse with it.
 */
export function SidebarPanel({
  items,
  label,
  footer,
  action,
}: SidebarPanelProps) {
  const { collapsed, isMobile } = useSidebar();
  const contentsId = useId();

  return (
    <VariantContext.Provider value="panel">
      <PanelCard $collapsed={collapsed}>
        {!isMobile && (
          <PanelHeader $collapsed={collapsed}>
            <PanelToggle controls={contentsId} />
          </PanelHeader>
        )}
        <PanelContents id={contentsId}>
          {action && <PanelAction $collapsed={collapsed}>{action}</PanelAction>}
          <PanelBody aria-label={label} $collapsed={collapsed}>
            <NavSections items={items} variant="panel" />
          </PanelBody>
          {footer && <PanelFooter $collapsed={collapsed}>{footer}</PanelFooter>}
        </PanelContents>
      </PanelCard>
    </VariantContext.Provider>
  );
}

const Shell = styled<'div', { $framed: boolean }>(
  'div',
  ({ $theme, $framed }) => ({
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    backgroundColor: $theme.colors.backgroundSecondary,
    // On desktop the window never scrolls; the page area beside the sidebar does,
    // so its scrollbar sits next to the content rather than at the window's edge.
    [DESKTOP]: {
      flexDirection: 'row',
      height: '100dvh',
      overflow: 'hidden',
      ...($framed && {
        height: '100%',
        minHeight: 0,
        borderRadius: $theme.borders.radius400,
      }),
    },
  }),
);

// A framed shell sits inset in a ribbon of the cards' own background, with rounded corners.
const Frame = styled('div', ({ $theme }) => ({
  [DESKTOP]: {
    boxSizing: 'border-box',
    height: '100dvh',
    padding: $theme.sizing.scale300,
    backgroundColor: $theme.colors.backgroundPrimary,
  },
}));

const DesktopRail = styled('aside', {
  display: 'none',
  flexShrink: 0,
  position: 'sticky',
  top: 0,
  boxSizing: 'border-box',
  height: '100%',
  [DESKTOP]: {
    display: 'block',
  },
});

const PANEL_ENTER = {
  from: { opacity: 0, transform: 'translateX(-4px)' },
  to: { opacity: 1, transform: 'none' },
};

// Mounts with the section's layout, so it eases in on entering a section, not on moving within one.
const DesktopPanel = styled('aside', ({ $theme }) => ({
  display: 'none',
  flexShrink: 0,
  boxSizing: 'border-box',
  height: '100%',
  paddingBlock: $theme.sizing.scale400,
  paddingInlineEnd: $theme.sizing.scale300,
  [DESKTOP]: {
    display: 'block',
  },
  // One query rather than an override, since two media rules would race on stylesheet order.
  [`${DESKTOP} and (prefers-reduced-motion: no-preference)`]: {
    animationName: PANEL_ENTER,
    animationDuration: $theme.animation.timing150,
    animationTimingFunction: $theme.animation.easeOutCurve,
  },
}));

// baseui slides the drawer in over 400ms; navigation should be at hand sooner.
const NAV_DRAWER_OVERRIDES = {
  DrawerContainer: {
    style: ({ $theme }: { $theme: Theme }) => ({
      transitionDuration: $theme.animation.timing200,
      [REDUCED_MOTION]: { transitionDuration: '0s' },
    }),
  },
  Backdrop: {
    style: ({ $theme }: { $theme: Theme }) => ({
      transitionDuration: $theme.animation.timing200,
      [REDUCED_MOTION]: { transitionDuration: '0s' },
    }),
  },
};

const MobileBar = styled('header', ({ $theme }) => ({
  ...expandBorderStyles($theme.borders.border200),
  borderTopStyle: 'none',
  borderRightStyle: 'none',
  borderLeftStyle: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
  position: 'sticky',
  top: 0,
  zIndex: 1,
  paddingBlock: $theme.sizing.scale300,
  paddingInline: $theme.sizing.scale300,
  backgroundColor: $theme.colors.backgroundPrimary,
  [DESKTOP]: {
    display: 'none',
  },
}));

const DrawerContent = styled('div', ({ $theme }) => ({
  display: 'flex',
  height: '100%',
  boxSizing: 'border-box',
  paddingBlock: $theme.sizing.scale300,
  paddingInlineEnd: $theme.sizing.scale300,
  backgroundColor: $theme.colors.backgroundSecondary,
}));

// Jumps within a page (links to a section, back to the top) glide rather than snap, unless motion is reduced.
const SMOOTH_SCROLL = {
  '@media (prefers-reduced-motion: no-preference)': {
    scrollBehavior: 'smooth',
  },
} as const;

const Main = styled('main', {
  flexGrow: 1,
  minWidth: 0,
  [DESKTOP]: {
    overflowY: 'auto',
  },
  ...SMOOTH_SCROLL,
});

function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && target.isContentEditable;
}

export interface SidebarLayoutProps {
  /** Usually a <Sidebar />: the app's main rail. */
  sidebar: ReactNode;
  /** Shown next to the menu button on small screens, e.g. the product logo. */
  brand?: ReactNode;
  /** Accessible name of the menu button. */
  menuLabel?: string;
  /** Controlled collapsed state of the desktop rail. */
  collapsed?: boolean;
  /**
   * Initial collapsed state when uncontrolled.
   */
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Initial collapsed state of the desktop panel; read SIDEBAR_PANEL_COLLAPSED_COOKIE on the server, as for `defaultCollapsed`. */
  defaultPanelCollapsed?: boolean;
  /** On desktop, inset from the window's edges with rounded corners, on the window's background. */
  framed?: boolean;
  children: ReactNode;
}

/**
 * App shell: the rail, then the page. On desktop the rail collapses to icons
 * (button or Cmd/Ctrl+B); on small screens navigation opens in a drawer. Nested
 * layouts add a secondary panel with SidebarPanelLayout.
 */
export function SidebarLayout({
  sidebar,
  brand,
  menuLabel = 'Open menu',
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,
  defaultPanelCollapsed = false,
  framed = false,
  children,
}: SidebarLayoutProps) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const [uncontrolledCollapsed, setUncontrolledCollapsed] =
    useState(defaultCollapsed);
  const collapsed = collapsedProp ?? uncontrolledCollapsed;
  // The drawer stays open only on the route it was opened from, so following a link closes it.
  const [drawerOpenedOn, setDrawerOpenedOn] = useState<string | null>(null);
  const drawerOpen = drawerOpenedOn === pathname;
  const [panel, setPanel] = useState<ReactNode>(null);

  const setCollapsed = useCallback(
    (next: boolean) => {
      if (collapsedProp === undefined) setUncontrolledCollapsed(next);
      onCollapsedChange?.(next);
      saveCookie(SIDEBAR_COLLAPSED_COOKIE, next);
    },
    [collapsedProp, onCollapsedChange],
  );

  const [savedPanelCollapsed, setPanelCollapsedState] = useState(
    defaultPanelCollapsed,
  );
  const [panelMadeRoom, setPanelMadeRoom] = useState(false);
  const panelCollapsed = savedPanelCollapsed || panelMadeRoom;
  const setPanelCollapsed = useCallback((next: boolean) => {
    setPanelMadeRoom(false);
    setPanelCollapsedState(next);
    saveCookie(SIDEBAR_PANEL_COLLAPSED_COOKIE, next);
  }, []);

  const toggle = useCallback(() => {
    if (isMobile) setDrawerOpenedOn(drawerOpen ? null : pathname);
    else setCollapsed(!collapsed);
  }, [isMobile, drawerOpen, pathname, collapsed, setCollapsed]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const shortcut =
        event.key.toLowerCase() === 'b' && (event.metaKey || event.ctrlKey);
      if (
        !shortcut ||
        event.altKey ||
        event.shiftKey ||
        isEditable(event.target)
      )
        return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  const state: SidebarState = {
    collapsed,
    setCollapsed,
    isMobile,
    toggle,
    collapsible: true,
    panelCollapsed,
    setPanelCollapsed,
    setPanelMadeRoom,
  };
  // The panel and mobile bar never show the icon rail; in the drawer the rail is
  // icons only beside a panel, or full width on its own, and the panel is always open.
  const expandedState: SidebarState = {
    ...state,
    collapsed: false,
    collapsible: false,
    panelCollapsed: false,
  };
  const drawerRailState: SidebarState = {
    ...state,
    collapsed: Boolean(panel),
    collapsible: false,
  };

  const shell = (
    <Shell $framed={framed}>
      <DesktopRail>{sidebar}</DesktopRail>
      <MobileBar>
        <Button
          kind={KIND.tertiary}
          shape={SHAPE.circle}
          aria-label={menuLabel}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpenedOn(pathname)}
        >
          <MenuIcon size={20} aria-hidden />
        </Button>
        <SidebarContext.Provider value={expandedState}>
          {brand}
        </SidebarContext.Provider>
      </MobileBar>
      <Drawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpenedOn(null)}
        anchor={ANCHOR.left}
        size={DRAWER_SIZE.auto}
        label="Navigation menu"
        overrides={NAV_DRAWER_OVERRIDES}
      >
        <DrawerContent>
          <SidebarContext.Provider value={drawerRailState}>
            {sidebar}
          </SidebarContext.Provider>
          {panel && (
            <SidebarContext.Provider value={expandedState}>
              {panel}
            </SidebarContext.Provider>
          )}
        </DrawerContent>
      </Drawer>
      <Main>
        <PanelRegistryContext.Provider value={setPanel}>
          {children}
        </PanelRegistryContext.Provider>
      </Main>
    </Shell>
  );

  return (
    <SidebarContext.Provider value={state}>
      {framed ? <Frame>{shell}</Frame> : shell}
    </SidebarContext.Provider>
  );
}

// On desktop the page beside the panel scrolls on its own, so the panel never moves with it.
const PanelShell = styled('div', {
  display: 'flex',
  minHeight: '100%',
  [DESKTOP]: { height: '100%' },
});

const PanelContent = styled('div', {
  flexGrow: 1,
  minWidth: 0,
  [DESKTOP]: { overflowY: 'auto' },
  ...SMOOTH_SCROLL,
});

export interface SidebarPanelLayoutProps {
  /** Usually a <SidebarPanel />: navigation within this area of the app. */
  panel: ReactNode;
  children: ReactNode;
}

/**
 * For a nested layout inside SidebarLayout: shows `panel` between the rail and
 * the page on desktop, and in the navigation drawer on small screens.
 */
export function SidebarPanelLayout({
  panel,
  children,
}: SidebarPanelLayoutProps) {
  const state = useSidebar();
  const registerPanel = useContext(PanelRegistryContext);

  useEffect(() => {
    registerPanel(panel);
    return () => registerPanel(null);
  }, [registerPanel, panel]);

  return (
    <PanelShell>
      <DesktopPanel>
        <SidebarContext.Provider
          value={{
            ...state,
            collapsed: state.panelCollapsed,
            collapsible: false,
          }}
        >
          {panel}
        </SidebarContext.Provider>
      </DesktopPanel>
      <PanelContent>{children}</PanelContent>
    </PanelShell>
  );
}
