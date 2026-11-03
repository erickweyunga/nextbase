import { styled, type Theme } from 'baseui';
import { Checkbox, type CheckboxProps } from 'baseui/checkbox-v2';
import { mergeOverrides } from 'baseui/helpers/overrides';
import { SIZE as PAGINATION_SIZE, Pagination } from 'baseui/pagination';
import { Skeleton } from 'baseui/skeleton';
import { SIZE as SPINNER_SIZE, Spinner } from 'baseui/spinner';
import { expandBorderStyles } from 'baseui/styles';
import {
  TableBuilder as BaseTableBuilder,
  type TableBuilderProps as BaseTableBuilderProps,
  SIZE,
  StyledTableBody,
  StyledTableBodyRow,
} from 'baseui/table-semantic';
import {
  Children,
  type ComponentProps,
  cloneElement,
  isValidElement,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ChevronRightIcon } from '../icons/index.tsx';
import { Select } from '../select/select';
import { useSidePanelOpen } from '../side-panel/side-panel';
import { VISUALLY_HIDDEN_STYLE } from '../visually-hidden/visually-hidden';

// baseui's compact cells pad as much vertically as horizontally and pin content to the top of the row.
// A column's own cell style replaces this one rather than adding to it, so column overrides include it.
const cellStyle = ({ $theme }: { $theme: Theme }) => ({
  paddingTop: $theme.sizing.scale300,
  paddingBottom: $theme.sizing.scale300,
  verticalAlign: 'middle',
});

const DEFAULT_PAGE_SIZE = 50;

// The rounded card clips the scrolling table inside it, so its scrollbars stay
// within the rounded corners instead of squaring them off. In a height-bounded
// column (PageContent wide) it shrinks and the table scrolls, header pinned.
const Card = styled<'div', { $framed: boolean }>(
  'div',
  ({ $theme, $framed }) => ({
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 1,
    minHeight: 0,
    overflow: 'hidden',
    borderRadius: $framed ? $theme.borders.radius300 : $theme.borders.radius400,
    backgroundColor: $theme.colors.tableBackground,
    ...($framed ? expandBorderStyles($theme.borders.border200) : {}),
  }),
);

const PaginationBar = styled('div', {
  display: 'flex',
  flexShrink: 0,
  justifyContent: 'flex-end',
});

export type TableBuilderProps<RowT> = BaseTableBuilderProps<RowT> & {
  /** Highlights the rows it returns true for, e.g. `selection.isSelected`. */
  isRowSelected?: (row: RowT) => boolean;
  /** Rows per page; pagination appears below the table once `data` has more rows than this. */
  pageSize?: number;
  /**
   * More rows exist on the server beyond `data`, e.g. a cursor-paged list. Pagination counts one page
   * more, and moving onto it calls `onLoadMore`; the table shows its loading state until the rows arrive.
   * Load the same number of rows per request as `pageSize`, so each page is one request.
   */
  hasMore?: boolean;
  onLoadMore?: () => void;
  /**
   * Makes the whole row clickable, e.g. to open it. A convenience for pointer
   * users: keep a link or button in the row for keyboard and screen readers.
   * Clicks on controls inside the row (checkbox, buttons, links) stay theirs.
   */
  onRowClick?: (row: RowT) => void;
  /** The pointer moved onto a row or focus moved into it: a moment to prefetch what `onRowClick` opens. */
  onRowIntent?: (row: RowT) => void;
  /**
   * Hides the column names, for a table inside a titled card where they repeat what the rows already say.
   * They stay for screen readers, which need them to make sense of each cell.
   */
  hideHeader?: boolean;
  /** Draws a border around the table, as Section does around its content. */
  framed?: boolean;
  /**
   * Splits the rows into titled sections that open and close, each a run of `data` in order: the first
   * section's `size` rows, then the next's. Each section's title row spans the table.
   */
  sections?: TableRowSection[];
};

export interface TableRowSection {
  id: string;
  title: ReactNode;
  /** How many of `data`'s rows, after the previous section's, are this section's. */
  size: number;
  /** Beside the title, at the end of its row, e.g. a menu of what can be done to the section's rows. */
  actions?: ReactNode;
}

// As tall as a row of the table, and as wide: clicking anywhere on it opens or closes the section.
const SectionTitleRow = styled('div', ({ $theme }) => ({
  ...$theme.typography.ParagraphMedium,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale300,
  minHeight: '24px',
  color: $theme.colors.contentPrimary,
  cursor: 'pointer',
}));

// As wide as the selection column, less the gap the next column's text starts after, so the arrow sits over
// the checkboxes and the title lines up with the first column's text.
const ChevronSlot = styled('span', ({ $theme }) => ({
  display: 'inline-flex',
  flexShrink: 0,
  width: `calc(${SELECTION_COLUMN_WIDTH} - ${$theme.sizing.scale300})`,
}));

const Chevron = styled<'span', { $open: boolean }>(
  'span',
  ({ $theme, $open }) => ({
    display: 'inline-flex',
    justifyContent: 'center',
    // baseui's checkmark box (17px from the same cell padding), so the arrow's centre is the checkboxes' centre.
    width: '17px',
    transform: $open ? 'rotate(90deg)' : 'none',
    transitionProperty: 'transform',
    transitionDuration: $theme.animation.timing200,
    transitionTimingFunction: $theme.animation.easeInOutCurve,
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '1ms' },
  }),
);

// Rows coming into view as their section opens.
const ROW_ENTER = {
  from: { opacity: 0, transform: 'translateY(-4px)' },
  to: { opacity: 1, transform: 'none' },
};

const SectionToggle = styled('button', ({ $theme }) => ({
  ...$theme.typography.ParagraphMedium,
  display: 'inline-flex',
  alignItems: 'center',
  padding: 0,
  border: 'none',
  background: 'none',
  color: 'inherit',
  cursor: 'pointer',
  ':focus-visible': {
    outline: `2px solid ${$theme.colors.borderAccent}`,
    outlineOffset: '2px',
  },
}));

// No taller than the title, so a section with actions is as tall as one without; its button overhangs a little.
const SectionActions = styled('div', {
  display: 'inline-flex',
  alignItems: 'center',
  height: '24px',
  marginInlineStart: 'auto',
});

// The table's last row has no line under it, so a title after it draws its own above; and the table's last row
// being a title, it leaves the line off too.
const SectionCell = styled<'td', { $lineAbove: boolean; $lineBelow: boolean }>(
  'td',
  ({ $theme, $lineAbove, $lineBelow }) => {
    const line = `${$theme.borders.border200.borderWidth} solid ${$theme.borders.border200.borderColor}`;
    return {
      paddingBlock: $theme.sizing.scale300,
      paddingInline: $theme.sizing.scale500,
      borderTop: $lineAbove ? line : undefined,
      borderBottom: $lineBelow ? line : undefined,
      backgroundColor: $theme.colors.tableBackground,
    };
  },
);

function SectionTitle({
  section,
  open,
  onToggle,
}: {
  section: TableRowSection;
  open: boolean;
  onToggle: () => void;
}) {
  // The button carries the state for keyboards and screen readers; its click reaches the row like any other.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const { target, currentTarget } = event;
    // The actions' menu opens in a popover elsewhere in the page, whose clicks still bubble here through React.
    if (!(target instanceof Node) || !currentTarget.contains(target)) return;
    if (target instanceof Element && target.closest('[data-section-actions]'))
      return;
    onToggle();
  };
  return (
    <SectionTitleRow onClick={onClick}>
      <SectionToggle type="button" aria-expanded={open}>
        <ChevronSlot>
          <Chevron $open={open}>
            <ChevronRightIcon size={20} aria-hidden />
          </Chevron>
        </ChevronSlot>
        {section.title}
      </SectionToggle>
      {section.actions && (
        <SectionActions data-section-actions="">
          {section.actions}
        </SectionActions>
      )}
    </SectionTitleRow>
  );
}

type SectionedBodyProps = ComponentProps<typeof StyledTableBody> & {
  /** Title rows to put before the body's row at each index. */
  $titles?: Map<number, ReactNode[]>;
  /** Title rows after the last row: sections that start where the rows end. */
  $trailing?: ReactNode[];
  $columns?: number;
  /** Each row's key by its section, so the rows of a section that opens are new, and come in animated. */
  $rowKeys?: string[];
};

// Module-level, like ClickableRow, so the body keeps its identity; what to insert arrives as props.
function SectionedBody({
  $titles,
  $trailing,
  $columns,
  $rowKeys,
  children,
  ...props
}: SectionedBodyProps) {
  const rows = Children.toArray(children);
  const trailing = $trailing ?? [];
  const titleRow = (
    title: ReactNode,
    key: string,
    lineAbove: boolean,
    lineBelow: boolean,
  ) => (
    <tr key={key}>
      <SectionCell
        colSpan={$columns}
        $lineAbove={lineAbove}
        $lineBelow={lineBelow}
      >
        {title}
      </SectionCell>
    </tr>
  );
  return (
    <StyledTableBody {...props}>
      {rows.flatMap((row, i) => [
        ...($titles?.get(i) ?? []).map((title, j) =>
          titleRow(title, `title-${i}-${j}`, false, true),
        ),
        isValidElement(row) && $rowKeys?.[i]
          ? cloneElement(row, { key: $rowKeys[i] })
          : row,
      ])}
      {trailing.map((title, j) =>
        titleRow(
          title,
          `trailing-${j}`,
          j === 0 && rows.length > 0,
          j < trailing.length - 1,
        ),
      )}
    </StyledTableBody>
  );
}

const LoadingArea = styled('div', ({ $theme }) => ({
  display: 'flex',
  justifyContent: 'center',
  paddingBlock: $theme.sizing.scale1600,
}));

// One placeholder row while loading.
const SKELETON_ROWS = [0] as never[];

function skeletonCell() {
  return <Skeleton animation width="70%" height="14px" />;
}

/** What a table split into sections, or given its own `loadingMessage`, shows while loading. */
function TableSpinner() {
  return (
    <LoadingArea role="status" aria-label="Loading">
      <Spinner $size={SPINNER_SIZE.medium} />
    </LoadingArea>
  );
}

/**
 * While a side panel opens beside the table, keeps the table scrolled to its far end, so the
 * row actions in the last column stay in view as it narrows. Stops once the user scrolls back.
 */
function useScrollToEndWhilePanelOpens(card: RefObject<HTMLDivElement | null>) {
  const panelOpen = useSidePanelOpen();
  useEffect(() => {
    // baseui's table root, the element that scrolls sideways.
    const root = card.current?.firstElementChild;
    if (!panelOpen || !(root instanceof HTMLElement)) return;
    const end = () => root.scrollWidth - root.clientWidth;
    const toEnd = () => root.scrollTo({ left: end() });
    const resize = new ResizeObserver(toEnd);
    const stop = () => {
      if (root.scrollLeft < end() - 1) resize.disconnect();
    };
    toEnd();
    resize.observe(root);
    root.addEventListener('scroll', stop);
    return () => {
      resize.disconnect();
      root.removeEventListener('scroll', stop);
    };
  }, [card, panelOpen]);
}

type ClickableRowProps = ComponentProps<typeof StyledTableBodyRow> & {
  $row?: unknown;
  $onRowClick?: (row: unknown) => void;
  $onRowIntent?: (row: unknown) => void;
};

// Module-level (not created per render) so rows keep their identity; the handler arrives as a prop.
function ClickableRow({
  $onRowClick,
  $onRowIntent,
  ...props
}: ClickableRowProps) {
  const onClick = (event: MouseEvent<HTMLTableRowElement>) => {
    const { target } = event;
    if (
      !$onRowClick ||
      (target instanceof Element &&
        target.closest('a, button, input, label, textarea, select'))
    ) {
      return;
    }
    $onRowClick(props.$row);
  };
  const intent = $onRowIntent && (() => $onRowIntent(props.$row));
  return (
    <StyledTableBodyRow
      {...props}
      onClick={$onRowClick ? onClick : undefined}
      onPointerEnter={intent}
      onFocus={intent}
    />
  );
}

/**
 * baseui's semantic TableBuilder: compact, vertically centred rows and rounded
 * corners by default, paginated beyond `pageSize` rows. Columns are
 * TableBuilderColumn children.
 */
export function TableBuilder<RowT>({
  size = SIZE.compact,
  isRowSelected,
  pageSize = DEFAULT_PAGE_SIZE,
  hasMore = false,
  onLoadMore,
  onRowClick,
  onRowIntent,
  hideHeader = false,
  framed = false,
  data: allRows,
  sections,
  loadingMessage,
  overrides,
  ...props
}: TableBuilderProps<RowT>) {
  const card = useRef<HTMLDivElement>(null);
  useScrollToEndWhilePanelOpens(card);
  const [page, setPage] = useState(1);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  // Closed sections' rows leave the table; each section's title goes before its first row still shown.
  const data: RowT[] = [];
  const dataKeys: string[] = [];
  const sectionStarts: Array<{ section: TableRowSection; start: number }> = [];
  if (sections) {
    let offset = 0;
    for (const section of sections) {
      sectionStarts.push({ section, start: data.length });
      if (!closed.has(section.id)) {
        const shown = allRows.slice(offset, offset + section.size);
        data.push(...shown);
        dataKeys.push(...shown.map((_, i) => `${section.id}:${i}`));
      }
      offset += section.size;
    }
  } else {
    data.push(...allRows);
  }
  const titleOf = (section: TableRowSection) => (
    <SectionTitle
      key={section.id}
      section={section}
      open={!closed.has(section.id)}
      onToggle={() =>
        setClosed((current) => {
          const next = new Set(current);
          if (!next.delete(section.id)) next.add(section.id);
          return next;
        })
      }
    />
  );
  const loadedPages = Math.max(1, Math.ceil(data.length / pageSize));
  const numPages = loadedPages + (hasMore ? 1 : 0);
  // Filtering can leave fewer pages than the one open; show the last instead.
  const currentPage = Math.min(page, numPages);
  // On the page past what has loaded, waiting for onLoadMore's rows.
  const waiting = currentPage > loadedPages;
  // Asks for that page however the table got there: moving onto it, or rows leaving (a section closed) so the
  // page open is now past the loaded ones.
  const loadMore = useRef(onLoadMore);
  useEffect(() => {
    loadMore.current = onLoadMore;
  });
  useEffect(() => {
    if (waiting) loadMore.current?.();
  }, [waiting]);
  const pageStart = numPages > 1 ? (currentPage - 1) * pageSize : 0;
  const rows = waiting
    ? []
    : numPages > 1
      ? data.slice(pageStart, currentPage * pageSize)
      : data;
  const titles = new Map<number, ReactNode[]>();
  const trailing: ReactNode[] = [];
  const isLastPage = currentPage === numPages;
  // Rows hidden by closed sections (or sections with none) leave only the titles, shown as rows all the same.
  const allClosed =
    sections !== undefined && allRows.length > 0 && data.length === 0;
  const loading = Boolean(props.isLoading) || waiting;
  if (sections && loading) {
    // The spinner shows inside the first section, the others' titles after it.
    const [first, ...rest] = sectionStarts;
    if (first) titles.set(0, [titleOf(first.section)]);
    trailing.push(...rest.map(({ section }) => titleOf(section)));
  } else if (rows.length > 0 || allClosed) {
    for (const { section, start } of sectionStarts) {
      const at = start - pageStart;
      if (at >= 0 && at < rows.length)
        titles.set(at, [...(titles.get(at) ?? []), titleOf(section)]);
      else if (at === rows.length && isLastPage)
        trailing.push(titleOf(section));
    }
  }
  const columns = Children.toArray(props.children).length;
  const skeleton = loading && !sections && loadingMessage === undefined;
  const children = skeleton
    ? Children.map(props.children, (column) =>
        isValidElement<{ children?: unknown; header?: ReactNode }>(column) &&
        column.props.header !== ''
          ? cloneElement(column, { children: skeletonCell })
          : column,
      )
    : props.children;

  return (
    <>
      <Card ref={card} $framed={framed}>
        <BaseTableBuilder
          size={size}
          data={skeleton ? SKELETON_ROWS : rows}
          loadingMessage={loadingMessage ?? <TableSpinner />}
          {...props}
          emptyMessage={allClosed ? undefined : props.emptyMessage}
          isLoading={!skeleton && (props.isLoading || waiting)}
          children={children}
          overrides={mergeOverrides(
            {
              Root: {
                style: {
                  flexShrink: 1,
                  minHeight: 0,
                  scrollbarWidth: 'thin',
                  ...(framed && { borderStyle: 'none' }),
                },
              },
              TableHeadCell: { style: cellStyle },
              ...(hideHeader && {
                TableHead: { style: VISUALLY_HIDDEN_STYLE },
              }),
              TableBodyCell: { style: cellStyle },
              ...(sections && {
                TableBody: {
                  component: SectionedBody,
                  props: {
                    $titles: titles,
                    $trailing: trailing,
                    $columns: columns,
                    $rowKeys: dataKeys.slice(
                      pageStart,
                      pageStart + rows.length,
                    ),
                  },
                },
              }),
              // Always opaque, so sticky cells (the selection column) can inherit it and cover what scrolls under them.
              TableBodyRow: {
                component: ClickableRow,
                props: skeleton
                  ? {}
                  : { $onRowClick: onRowClick, $onRowIntent: onRowIntent },
                style: ({ $theme, $row }: { $theme: Theme; $row: RowT }) => ({
                  backgroundColor:
                    !skeleton && isRowSelected?.($row)
                      ? $theme.colors.backgroundSecondary
                      : $theme.colors.tableBackground,
                  cursor: !skeleton && onRowClick ? 'pointer' : undefined,
                  ...(sections && {
                    animationName: ROW_ENTER,
                    animationDuration: $theme.animation.timing200,
                    animationTimingFunction: $theme.animation.easeOutCurve,
                    '@media (prefers-reduced-motion: reduce)': {
                      animationDuration: '1ms',
                    },
                  }),
                }),
              },
            },
            overrides,
          )}
        />
      </Card>
      {numPages > 1 && (
        <PaginationBar>
          <Pagination
            size={PAGINATION_SIZE.compact}
            numPages={numPages}
            currentPage={currentPage}
            onPageChange={({ nextPage }) => {
              const next = Math.min(Math.max(nextPage, 1), numPages);
              setPage(next);
            }}
            // baseui's own Select takes a react-uid popover id that differs between server and client.
            overrides={{ Select: { component: Select } }}
          />
        </PaginationBar>
      )}
    </>
  );
}

export interface RowSelection<RowT> {
  isSelected: (row: RowT) => boolean;
  /** The selected rows among `rows`, in their order. */
  selectedRows: RowT[];
  allSelected: boolean;
  someSelected: boolean;
  toggle: (row: RowT) => void;
  /** Selects every row in `rows`, or clears them when all are already selected. */
  toggleAll: () => void;
  clear: () => void;
}

/**
 * Checkbox selection for the rows currently shown. Selection survives filtering:
 * rows filtered out stay selected and come back selected.
 */
export function useRowSelection<RowT>(
  rows: RowT[],
  getKey: (row: RowT) => string,
): RowSelection<RowT> {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const isSelected = (row: RowT) => selected.has(getKey(row));
  const selectedRows = rows.filter(isSelected);
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  return {
    isSelected,
    selectedRows,
    allSelected,
    someSelected: selectedRows.length > 0 && !allSelected,
    toggle: (row) =>
      setSelected((current) => {
        const next = new Set(current);
        if (!next.delete(getKey(row))) next.add(getKey(row));
        return next;
      }),
    toggleAll: () =>
      setSelected((current) => {
        const next = new Set(current);
        for (const row of rows) {
          if (allSelected) next.delete(getKey(row));
          else next.add(getKey(row));
        }
        return next;
      }),
    clear: () => setSelected(new Set()),
  };
}

// Fixed rather than fit-to-content, so a pinned column beside it knows where to stick.
const SELECTION_COLUMN_WIDTH = '48px';

interface CellStyleArg {
  $theme: Theme;
}

// Keeps its own right padding: while the table scrolls sideways the next column's
// left padding scrolls away under it, so the gap has to come from the pinned cell.
const selectionCell = ({ $theme }: CellStyleArg) =>
  ({
    boxSizing: 'border-box',
    width: SELECTION_COLUMN_WIDTH,
    minWidth: SELECTION_COLUMN_WIDTH,
    maxWidth: SELECTION_COLUMN_WIDTH,
    paddingRight: $theme.sizing.scale300,
    position: 'sticky',
    left: 0,
  }) as const;

// baseui's head cells are sticky to the top at z-index 1; pinned ones stick both ways, so they sit above them.
// Pinned body cells sit below the head cells but above the other body cells, and take the row's background
// (selected or hovered) so what scrolls under them stays hidden.
const pinnedHead = { zIndex: 2 } as const;
const pinnedBody = { zIndex: 0, backgroundColor: 'inherit' } as const;

/**
 * Narrow first column for selection checkboxes that stays in place when the table
 * scrolls sideways; pass as the TableBuilderColumn's `overrides`.
 */
export const SELECTION_COLUMN_OVERRIDES = {
  TableHeadCell: {
    style: (arg: CellStyleArg) => ({
      ...cellStyle(arg),
      ...selectionCell(arg),
      ...pinnedHead,
    }),
  },
  TableBodyCell: {
    style: (arg: CellStyleArg) => ({
      ...cellStyle(arg),
      ...selectionCell(arg),
      ...pinnedBody,
    }),
  },
};

// A hairline on the pinned edge, so columns scrolling under it read as passing beneath.
const pinnedCell = ({ $theme }: CellStyleArg, pin: Pin) =>
  ({
    position: 'sticky',
    left: pin === 'afterSelection' ? SELECTION_COLUMN_WIDTH : 0,
    // The selection cell already ends in a gap; with this the checkbox sits as far
    // from this column's content as from the table's edge.
    ...(pin === 'afterSelection' && {
      paddingLeft: `calc(${$theme.sizing.scale500} - ${$theme.sizing.scale300})`,
    }),
    boxShadow: `inset -1px 0 0 ${$theme.borders.border200.borderColor}`,
  }) as const;

/**
 * Pins the column right after the selection column (e.g. the name) so it stays
 * in view with the checkboxes when the table scrolls sideways.
 */
export const PINNED_COLUMN_OVERRIDES = columnOverrides({
  pin: 'afterSelection',
});

// Keeps the checkbox's 40px hit area without letting it set the row height.
const SELECTION_CHECKBOX_OVERRIDES = {
  // baseui's checkbox is inline-flex, so it sits on the cell's text baseline, a few pixels above the row's centre.
  Root: { style: { display: 'flex', alignItems: 'center' } },
  CheckmarkContainer: {
    style: ({ $theme }: { $theme: Theme }) => ({
      margin: `-${$theme.sizing.scale300}`,
    }),
  },
};

/** A row or select-all checkbox sized for table cells. */
export interface ColumnLayout {
  /** A fixed width, e.g. "120px"; columns without one share what is left. */
  width?: string;
  /** "end" for numbers and row actions. */
  align?: 'start' | 'end';
  /** Keep the cell on one line. */
  nowrap?: boolean;
  /**
   * Take the width the other columns leave, however narrow, so the table never scrolls sideways for this
   * column; its content cuts itself to fit (e.g. one line ending in "…").
   */
  fill?: boolean;
  /**
   * Keep the column in view when the table scrolls sideways: "afterSelection" beside the selection
   * column, "first" at the table's edge for a table without one.
   */
  pin?: Pin;
}

type Pin = 'afterSelection' | 'first';

/** Overrides that size and align one column, keeping the table's cell padding. */
export function columnOverrides({
  width,
  align = 'start',
  nowrap = false,
  fill = false,
  pin,
}: ColumnLayout) {
  const layout = {
    ...(width && { width, minWidth: width }),
    // A table cell grows to fit what's in it unless capped; width 100% with no max lets it take the rest instead.
    ...(fill && { width: '100%', maxWidth: 0 }),
    ...(align === 'end' && { textAlign: 'end' as const }),
    ...(nowrap && { whiteSpace: 'nowrap' as const }),
  };
  const style = (
    arg: CellStyleArg,
    stuck: typeof pinnedHead | typeof pinnedBody,
  ) => ({
    ...cellStyle(arg),
    ...layout,
    ...(pin && { ...pinnedCell(arg, pin), ...stuck }),
  });
  return {
    TableHeadCell: { style: (arg: CellStyleArg) => style(arg, pinnedHead) },
    TableBodyCell: { style: (arg: CellStyleArg) => style(arg, pinnedBody) },
  };
}

export function SelectionCheckbox(
  props: Omit<CheckboxProps, 'overrides'> & { 'aria-label': string },
) {
  return <Checkbox {...props} overrides={SELECTION_CHECKBOX_OVERRIDES} />;
}
