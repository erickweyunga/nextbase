import { styled, type Theme } from 'baseui';
import { createContext, type ReactNode, useContext } from 'react';
import { COMPACT_CONTROL_HEIGHT } from '../control-height';
import { HelpIcon, SearchIcon } from '../icons/index.tsx';
import { Input } from '../input/input';
import { PLACEMENT, Tooltip } from '../tooltip';

const Root = styled<'header', { $variant: PageHeaderVariant; $inset: boolean }>(
  'header',
  ({ $theme, $variant, $inset }) => ({
    display: 'grid',
    rowGap: $theme.sizing.scale300,
    ...($variant === 'large'
      ? {
          position: 'sticky',
          top: 0,
          flexShrink: 0,
          zIndex: 2,
          // Same top padding and row height as the sidebar header, so the toolbar lines up with the logo.
          // An inset header's content area already does that, and the content below sets its own gap.
          paddingBlock: $inset ? 0 : $theme.sizing.scale600,
          // Matches the app background, so rows scrolling underneath are hidden.
          backgroundColor: $theme.colors.backgroundSecondary,
        }
      : {}),
  }),
);

// The large header's row is a size container, so its button labels collapse by
// the room the toolbar actually has (sidebar and side panel take some), not the window's.
const TOOLBAR_CONTAINER = 'page-header-toolbar';
const DEFAULT_COLLAPSE_LABELS_BELOW = 900;

// How narrow the toolbar gets before PageHeaderButtonLabel shows icons only.
const CollapseContext = createContext(DEFAULT_COLLAPSE_LABELS_BELOW);

const Row = styled<'div', { $variant: PageHeaderVariant }>(
  'div',
  ({ $theme, $variant }) => ({
    // As tall as the sidebar header's row in both variants, so a title lines up with the menu's toggle beside it.
    minHeight: '40px',
    ...($variant === 'large'
      ? { containerType: 'inline-size', containerName: TOOLBAR_CONTAINER }
      : {}),
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: $theme.sizing.scale500,
  }),
);

const TitleGroup = styled('div', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
  minWidth: 0,
}));

const TitleIcon = styled('span', ({ $theme }) => ({
  display: 'inline-flex',
  flexShrink: 0,
  color: $theme.colors.contentSecondary,
}));

const Title = styled<'h1', { $variant: PageHeaderVariant }>(
  'h1',
  ({ $theme, $variant }) => ({
    ...($variant === 'large'
      ? $theme.typography.LabelLarge
      : $theme.typography.HeadingSmall),
    margin: 0,
    color: $theme.colors.contentPrimary,
    whiteSpace: $variant === 'large' ? 'nowrap' : undefined,
  }),
);

const Search = styled('div', {
  flexGrow: 1,
  flexBasis: '160px',
  maxWidth: '240px',
});

const HelpButton = styled('button', ({ $theme }) => ({
  display: 'inline-flex',
  padding: 0,
  borderWidth: 0,
  borderRadius: '50%',
  backgroundColor: 'transparent',
  color: $theme.colors.contentTertiary,
  cursor: 'help',
  ':hover': { color: $theme.colors.contentPrimary },
  ':focus-visible': {
    outline: `3px solid ${$theme.colors.borderAccent}`,
    outlineOffset: '2px',
  },
}));

const Actions = styled('div', ({ $theme }) => ({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
  marginInlineStart: 'auto',
}));

const Description = styled('p', ({ $theme }) => ({
  ...$theme.typography.ParagraphMedium,
  margin: 0,
  color: $theme.colors.contentTertiary,
}));

function Help({ children }: { children: ReactNode }) {
  return (
    <Tooltip content={children} placement={PLACEMENT.right}>
      <HelpButton type="button" aria-label="Help">
        <HelpIcon size={20} aria-hidden />
      </HelpButton>
    </Tooltip>
  );
}

export type PageHeaderVariant = 'default' | 'large';

export interface PageHeaderProps {
  title: ReactNode;
  /**
   * `default`: a heading for a settings-style page. `large`: a toolbar for a
   * list or workspace page, with a compact title, an `icon`, a `search` field
   * and a row of actions; it sticks to the top of the window while the page scrolls.
   */
  variant?: PageHeaderVariant;
  /** `large` only: no space above and below, for a content area that already pads it. */
  inset?: boolean;
  /** Before the title in the `large` variant, e.g. the list's icon. */
  icon?: ReactNode;
  /** After the title in the `large` variant, e.g. a search Input. */
  search?: ReactNode;
  description?: ReactNode;
  /** Shown in a tooltip from a help icon beside the title. */
  help?: ReactNode;
  /** End of the title row, e.g. a save status or page actions. */
  actions?: ReactNode;
  /**
   * `large` only: below this toolbar width (px), buttons labelled with
   * PageHeaderButtonLabel show their icon only. Default 900; lower it for fewer actions.
   */
  collapseLabelsBelow?: number;
}

/** The page's title (its h1), with optional help, description and actions. */
export function PageHeader({
  title,
  variant = 'default',
  inset = false,
  icon,
  search,
  description,
  help,
  actions,
  collapseLabelsBelow = DEFAULT_COLLAPSE_LABELS_BELOW,
}: PageHeaderProps) {
  const large = variant === 'large';

  return (
    <CollapseContext.Provider value={collapseLabelsBelow}>
      <Root $variant={variant} $inset={inset}>
        <Row $variant={variant}>
          <TitleGroup>
            {large && icon && <TitleIcon aria-hidden>{icon}</TitleIcon>}
            <Title $variant={variant}>{title}</Title>
            {help && <Help>{help}</Help>}
          </TitleGroup>
          {large && search && <Search>{search}</Search>}
          {actions && <Actions>{actions}</Actions>}
        </Row>
        {description && <Description>{description}</Description>}
      </Root>
    </CollapseContext.Provider>
  );
}

const ICON_SIZE = '16px';

const LabelRoot = styled<'span', { $below: number }>(
  'span',
  ({ $theme, $below }) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: $theme.sizing.scale300,
    [`@container ${TOOLBAR_CONTAINER} (max-width: ${$below}px)`]: {
      // Cancels the text button's side padding down to an icon button's, for a square button.
      marginInline: `calc((${COMPACT_CONTROL_HEIGHT} - ${ICON_SIZE}) / 2 - ${$theme.sizing.scale500})`,
    },
  }),
);

const LabelIcon = styled<'span', { $below: number; $expandedToo: boolean }>(
  'span',
  ({ $below, $expandedToo }) => ({
    display: $expandedToo ? 'inline-flex' : 'none',
    [`@container ${TOOLBAR_CONTAINER} (max-width: ${$below}px)`]: {
      display: 'inline-flex',
    },
  }),
);

// Visually hidden when collapsed, so the button keeps its accessible name.
const LabelText = styled<'span', { $below: number }>('span', ({ $below }) => ({
  [`@container ${TOOLBAR_CONTAINER} (max-width: ${$below}px)`]: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
}));

const LabelEnd = styled<'span', { $below: number }>('span', ({ $below }) => ({
  display: 'inline-flex',
  [`@container ${TOOLBAR_CONTAINER} (max-width: ${$below}px)`]: {
    display: 'none',
  },
}));

export interface PageHeaderButtonLabelProps {
  /** 16px icon; the whole label when the toolbar is narrow. */
  icon: ReactNode;
  children: ReactNode;
  /** After the text while there is room, e.g. a menu's chevron. */
  end?: ReactNode;
  /** Show `icon` only once collapsed, e.g. a "more" icon standing in for "Actions". */
  iconWhenCollapsedOnly?: boolean;
}

/**
 * A large PageHeader action's label (use as a Button's children, not with its
 * enhancers): icon and text while the toolbar has room, the icon alone in a
 * square button when it is narrow. The text stays as the accessible name.
 */
export function PageHeaderButtonLabel({
  icon,
  children,
  end,
  iconWhenCollapsedOnly = false,
}: PageHeaderButtonLabelProps) {
  const below = useContext(CollapseContext);
  return (
    <LabelRoot $below={below}>
      <LabelIcon
        $below={below}
        $expandedToo={!iconWhenCollapsedOnly}
        aria-hidden
      >
        {icon}
      </LabelIcon>
      <LabelText $below={below}>{children}</LabelText>
      {end && (
        <LabelEnd $below={below} aria-hidden>
          {end}
        </LabelEnd>
      )}
    </LabelRoot>
  );
}

// baseui fills inputs with the same grey as the large header, so the field would disappear into it.
const whiteFill = ({ $theme }: { $theme: Theme }) => ({
  backgroundColor: $theme.colors.backgroundPrimary,
});

const SEARCH_OVERRIDES = {
  Root: { style: whiteFill },
  InputContainer: { style: whiteFill },
  Input: {
    style: ({ $theme }: { $theme: Theme }) => ({
      ...whiteFill({ $theme }),
      paddingLeft: $theme.sizing.scale300,
    }),
  },
  StartEnhancer: {
    style: ({ $theme }: { $theme: Theme }) => ({
      ...whiteFill({ $theme }),
      paddingLeft: $theme.sizing.scale400,
      paddingRight: 0,
    }),
  },
};

export interface PageHeaderSearchProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Search customers". */
  label: string;
  placeholder?: string;
}

/** The search field for a `large` PageHeader's `search` slot. Escape clears it. */
export function PageHeaderSearch({
  value,
  onChange,
  label,
  placeholder = 'Search',
}: PageHeaderSearchProps) {
  return (
    <Input
      type="search"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={placeholder}
      aria-label={label}
      clearOnEscape
      startEnhancer={<SearchIcon size={16} aria-hidden />}
      overrides={SEARCH_OVERRIDES}
    />
  );
}
