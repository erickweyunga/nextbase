import type { Theme } from 'baseui';
import { mergeOverrides } from 'baseui/helpers/overrides';
import { columnOverrides } from '../ui/table/index.ts';

const MIN_WIDTH = '160px';

export const ID_COLUMN = mergeOverrides(
  columnOverrides({ width: MIN_WIDTH, nowrap: true, pin: 'afterSelection' }),
  {
    TableHeadCell: {
      style: ({ $theme }: { $theme: Theme }) => gridCell($theme),
    },
    TableBodyCell: {
      style: ({ $theme }: { $theme: Theme }) => gridCell($theme),
    },
  },
);

export const TEXT_COLUMN = columnOverrides({ width: MIN_WIDTH });

const FILLER_CELL = {
  style: { padding: 0, borderRightStyle: 'none' },
} as const;
export const FILLER_COLUMN = {
  TableHeadCell: FILLER_CELL,
  TableBodyCell: FILLER_CELL,
};
export const NOWRAP_COLUMN = columnOverrides({
  width: MIN_WIDTH,
  nowrap: true,
});
export const END_COLUMN = columnOverrides({
  width: MIN_WIDTH,
  align: 'end',
  nowrap: true,
});

function gridCell($theme: Theme) {
  return { paddingLeft: $theme.sizing.scale500, boxShadow: 'none' };
}

export const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
