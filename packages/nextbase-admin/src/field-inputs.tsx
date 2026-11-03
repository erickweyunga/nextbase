import type {
  Collection,
  FileField,
  RecordModel,
  RelationField,
} from '@nextbasejs/client';
import type { Theme } from 'baseui';
import { useEffect, useRef, useState } from 'react';
import { nb } from './api.ts';
import { asList, isImage, labelOf, searchFilter } from './record-text.ts';
import { Button, KIND, SHAPE, SIZE } from './ui/button/index.ts';
import {
  FILE_STATUS,
  type FileRow,
  FileUploader,
} from './ui/file-uploader/index.ts';
import { DeleteIcon, DescriptionIcon } from './ui/icons/index.tsx';
import { type Option, Select } from './ui/select/index.ts';
import { styled } from './ui/styles/index.ts';

const SEARCH_DELAY = 250;

const OPTIONS = 20;

const THUMB = '100x100';

const UPLOADER_OVERRIDES = {
  FileDragAndDrop: {
    style: ({ $theme }: { $theme: Theme }) => ({
      paddingTop: $theme.sizing.scale300,
      paddingRight: $theme.sizing.scale300,
      paddingBottom: $theme.sizing.scale300,
      paddingLeft: $theme.sizing.scale300,
      borderTopLeftRadius: $theme.borders.radius300,
      borderTopRightRadius: $theme.borders.radius300,
      borderBottomLeftRadius: $theme.borders.radius300,
      borderBottomRightRadius: $theme.borders.radius300,
    }),
  },
  ButtonComponent: { props: { size: SIZE.compact } },
};

export interface RelationOption {
  id: string;
  label: string;
}

export function relationOptions(
  field: RelationField,
  target: Collection | undefined,
  record?: RecordModel,
): RelationOption[] {
  const ids = asList(record?.[field.name]);
  const expanded = record?.expand?.[field.name];
  const related = Array.isArray(expanded) ? expanded : expanded && [expanded];
  return ids.map((id) => {
    const found = related?.find((r) => r.id === id);
    return { id, label: found ? labelOf(target, found) : id };
  });
}

export function RelationInput({
  field,
  target,
  value,
  onChange,
}: {
  field: RelationField;
  target: Collection | undefined;
  value: readonly RelationOption[];
  onChange: (value: RelationOption[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RelationOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !target) return;
    let current = true;
    const timer = setTimeout(() => {
      setLoading(true);
      nb.collection(target.name)
        .getList(1, OPTIONS, {
          filter: searchFilter(target, query) || undefined,
        })
        .then((result) => {
          if (!current) return;
          setOptions(
            result.items.map((r) => ({ id: r.id, label: labelOf(target, r) })),
          );
        })
        .catch(() => current && setOptions([]))
        .finally(() => current && setLoading(false));
    }, SEARCH_DELAY);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, target, query]);

  return (
    <Select
      options={options}
      value={[...value]}
      onChange={({ value: picked }) =>
        onChange(
          picked.map((option: Option) => ({
            id: String(option.id),
            label: String(option.label),
          })),
        )
      }
      onInputChange={(event) => setQuery(event.currentTarget.value)}
      onOpen={() => setOpen(true)}
      onClose={() => {
        setOpen(false);
        setQuery('');
      }}
      filterOptions={(all) => all}
      isLoading={loading}
      multi={field.maxSelect > 1}
      placeholder={target ? `Search ${target.name}` : undefined}
      disabled={!target}
      aria-label={field.name}
    />
  );
}

export interface FileValue {
  kept: string[];
  added: FileRow[];
}

const FileList = styled('ul', ({ $theme }) => ({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  rowGap: $theme.sizing.scale200,
}));

const FileItem = styled('li', ({ $theme }) => ({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: $theme.sizing.scale400,
  paddingBlock: $theme.sizing.scale200,
  paddingInline: $theme.sizing.scale400,
  borderRadius: $theme.borders.radius300,
  backgroundColor: $theme.colors.backgroundSecondary,
}));

const FileName = styled('a', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  flexGrow: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: $theme.colors.contentPrimary,
  textDecoration: 'none',
  ':hover': { textDecoration: 'underline' },
}));

const Preview = styled('span', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: '32px',
  height: '32px',
  overflow: 'hidden',
  borderRadius: $theme.borders.radius200,
  color: $theme.colors.contentTertiary,
  backgroundColor: $theme.colors.backgroundTertiary,
}));

const Thumb = styled('img', {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
});

const Stack = styled('div', ({ $theme }) => ({
  minWidth: 0,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  rowGap: $theme.sizing.scale300,
}));

export function FilePreview({
  record,
  name,
}: {
  record: Pick<RecordModel, 'id' | 'collectionId'>;
  name: string;
}) {
  return (
    <Preview>
      {isImage(name) ? (
        <Thumb
          src={nb.files.getUrl(record, name, { thumb: THUMB })}
          alt=""
          loading="lazy"
        />
      ) : (
        <DescriptionIcon size={18} aria-hidden />
      )}
    </Preview>
  );
}

function replacesKept(field: FileField, value: FileValue): boolean {
  return (
    field.maxSelect === 1 &&
    value.added.some((row) => row.status === FILE_STATUS.processed)
  );
}

export function fileBody(field: FileField, value: FileValue): unknown {
  const kept = replacesKept(field, value) ? [] : value.kept;
  const files = [
    ...kept,
    ...value.added
      .filter((row) => row.status === FILE_STATUS.processed)
      .map((row) => row.file),
  ];
  return field.maxSelect > 1 ? files : (files[0] ?? '');
}

export function FileInput({
  field,
  record,
  value,
  onChange,
}: {
  field: FileField;
  record?: RecordModel;
  value: FileValue;
  onChange: (value: FileValue) => void;
}) {
  const latest = useRef(value);
  latest.current = value;
  const kept = replacesKept(field, value) ? [] : value.kept;
  const room =
    field.maxSelect === 1
      ? 1
      : Math.max(field.maxSelect - value.kept.length, 0);

  return (
    <Stack>
      {record && kept.length > 0 && (
        <FileList>
          {kept.map((name) => (
            <FileItem key={name}>
              <FilePreview record={record} name={name} />
              <FileName
                href={nb.files.getUrl(record, name)}
                target="_blank"
                rel="noreferrer"
                title={name}
              >
                {name}
              </FileName>
              <Button
                type="button"
                kind={KIND.tertiary}
                shape={SHAPE.square}
                size={SIZE.mini}
                aria-label={`Remove ${name}`}
                onClick={() =>
                  onChange({
                    ...value,
                    kept: value.kept.filter((k) => k !== name),
                  })
                }
              >
                <DeleteIcon size={18} />
              </Button>
            </FileItem>
          ))}
        </FileList>
      )}
      {room > 0 && (
        <FileUploader
          fileRows={value.added}
          setFileRows={(added) => onChange({ ...latest.current, added })}
          maxFiles={room}
          maxSize={field.maxSize}
          {...(field.mimeTypes.length > 0 && { accept: field.mimeTypes })}
          multiple={field.maxSelect > 1}
          itemPreview
          overrides={UPLOADER_OVERRIDES}
        />
      )}
    </Stack>
  );
}
