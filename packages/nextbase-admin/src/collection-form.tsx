import {
  ClientError,
  type Collection,
  type CollectionInput,
  type Field,
} from '@nextbasejs/client';
import type { Theme } from 'baseui';
import { arrayMove, List } from 'baseui/dnd-list';
import { type FormEvent, useRef, useState } from 'react';
import { nb } from './api.ts';
import { Page } from './components/page.tsx';
import { errorAt } from './errors.ts';
import { Button, KIND, SHAPE, SIZE } from './ui/button/index.ts';
import { Checkbox, LABEL_PLACEMENT } from './ui/checkbox/index.ts';
import { FormControl } from './ui/form-control/index.ts';
import {
  AddIcon,
  DeleteIcon,
  DragIndicatorIcon,
  EditIcon,
  TuneIcon,
} from './ui/icons/index.tsx';
import { Input } from './ui/input/index.ts';
import { navigate } from './ui/navigation.tsx';
import { Section } from './ui/section/index.ts';
import { Select } from './ui/select/index.ts';
import { styled } from './ui/styles/index.ts';
import { Textarea } from './ui/textarea/index.ts';
import { toaster } from './ui/toast/index.ts';
import { useUnsavedChanges } from './unsaved.ts';

const TYPES = [
  { id: 'base', label: 'Base' },
  { id: 'auth', label: 'Auth' },
  { id: 'view', label: 'View' },
] as const satisfies readonly { id: Collection['type']; label: string }[];

const FIELD_TYPES = [
  { id: 'text', label: 'Plain text' },
  { id: 'number', label: 'Number' },
  { id: 'bool', label: 'Bool' },
  { id: 'email', label: 'Email' },
  { id: 'url', label: 'URL' },
  { id: 'phone', label: 'Phone' },
  { id: 'date', label: 'Date' },
  { id: 'autodate', label: 'Autodate' },
  { id: 'select', label: 'Select' },
  { id: 'relation', label: 'Relation' },
  { id: 'file', label: 'File' },
  { id: 'json', label: 'JSON' },
] as const;

const FIELD_TYPE_LABELS: Record<Field['type'], string> = {
  ...Object.fromEntries(FIELD_TYPES.map((t) => [t.id, t.label])),
  password: 'Password',
} as Record<Field['type'], string>;

const MB = 1024 * 1024;

const COMMON_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
];

type Options = Record<string, unknown>;

const DEFAULT_OPTIONS: Partial<Record<Field['type'], Options>> = {
  select: { values: [], maxSelect: 1 },
  relation: { collectionId: '', maxSelect: 1, cascadeDelete: false },
  file: { maxSelect: 1, maxSize: 5 * MB, mimeTypes: [], protected: false },
};

const SETTINGS = new Set<Field['type']>([
  'text',
  'number',
  'select',
  'relation',
  'file',
]);

const NEEDS_SETTINGS = new Set<Field['type']>(['select', 'relation']);

const OPTION_KEYS: Partial<Record<Field['type'], readonly string[]>> = {
  text: ['min', 'max'],
  number: ['min', 'max'],
  select: ['values', 'maxSelect'],
  relation: ['collectionId', 'maxSelect', 'cascadeDelete'],
  file: ['maxSelect', 'maxSize', 'mimeTypes', 'protected'],
};

const DEFAULT_LAST = new Set(['created', 'updated']);

interface FieldDraft {
  key: string;
  name: string;
  type: Field['type'];
  required: boolean;
  onUpdate?: boolean;
  last?: boolean;
  options: Options;
  open?: boolean;
  original?: Field;
}

const Form = styled('form', ({ $theme }) => ({
  display: 'flex',
  flexDirection: 'column',
  gap: $theme.sizing.scale700,
}));

const FieldList = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale200,
}));

const Controls = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale300,
}));

const FieldRow = styled('div', ({ $theme }) => ({
  "[data-baseweb='form-control-container']": { marginBottom: 0 },
  flexGrow: 1,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 180px 72px 36px 36px',
  alignItems: 'start',
  columnGap: $theme.sizing.scale500,
}));

const ColumnLabel = styled<'span', { $center?: boolean }>(
  'span',
  ({ $theme, $center }) => ({
    ...$theme.typography.LabelSmall,
    color: $theme.colors.contentPrimary,
    textAlign: $center ? 'center' : 'start',
  }),
);

const HANDLE_WIDTH = '20px';

const HeaderRow = styled('div', ({ $theme }) => ({
  display: 'flex',
  gap: $theme.sizing.scale300,
  ':before': { content: '""', width: HANDLE_WIDTH, flexShrink: 0 },
}));

const Handle = styled('span', ({ $theme }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: HANDLE_WIDTH,
  height: '36px',
  color: $theme.colors.contentTertiary,
  cursor: 'grab',
}));

const DRAG_LIST_OVERRIDES = {
  Root: { style: { width: '100%' } },
  List: { style: { margin: 0, padding: 0 } },
  Item: {
    style: ({
      $theme,
      $isDragged,
    }: {
      $theme: Theme;
      $isDragged: boolean;
    }) => ({
      alignItems: 'flex-start',
      gap: $theme.sizing.scale300,
      paddingBlock: $theme.sizing.scale200,
      paddingInline: 0,
      borderWidth: 0,
      borderRadius: $theme.borders.radius300,
      backgroundColor: $isDragged
        ? $theme.colors.backgroundPrimary
        : 'transparent',
      boxShadow: $isDragged ? $theme.lighting.shadow600 : 'none',
      ':hover': { borderWidth: 0 },
    }),
  },
  DragHandle: {
    component: () => (
      <Handle data-movable-handle aria-hidden>
        <DragIndicatorIcon size={16} />
      </Handle>
    ),
  },
  Label: { style: { flexGrow: 1, minWidth: 0, padding: 0 } },
};

const FieldItem = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale300,
}));

const Settings = styled('div', ({ $theme }) => ({
  "[data-baseweb='form-control-container']": { marginBottom: 0 },
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  alignItems: 'end',
  gap: $theme.sizing.scale500,
  padding: $theme.sizing.scale500,
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: $theme.colors.borderOpaque,
  borderRadius: $theme.borders.radius300,
}));

const Wide = styled('div', { gridColumn: '1 / -1' });

const SettingCheck = styled('div', {
  display: 'flex',
  alignItems: 'center',
  minHeight: '36px',
});

const RowCheck = styled('div', {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '36px',
});

const Actions = styled('div', ({ $theme }) => ({
  position: 'sticky',
  bottom: 0,
  marginTop: 'auto',
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 160px))',
  justifyContent: 'center',
  gap: $theme.sizing.scale500,
  paddingBlock: $theme.sizing.scale600,
  backgroundColor: $theme.colors.backgroundSecondary,
}));

let nextKey = 0;

function draft(fields: Partial<FieldDraft> = {}): FieldDraft {
  nextKey += 1;
  return {
    key: `field-${nextKey}`,
    name: '',
    type: 'text',
    required: false,
    options: {},
    ...fields,
  };
}

function initialFields(): FieldDraft[] {
  return [
    draft({ name: 'created', type: 'autodate', onUpdate: false, last: true }),
    draft({ name: 'updated', type: 'autodate', onUpdate: true, last: true }),
  ];
}

function withNewField(fields: readonly FieldDraft[]): FieldDraft[] {
  let at = fields.length;
  while (at > 0 && fields[at - 1]?.last) at -= 1;
  return [...fields.slice(0, at), draft(), ...fields.slice(at)];
}

function optionsOf(field: Field): Options {
  const keys = OPTION_KEYS[field.type] ?? [];
  const source = field as unknown as Options;
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

function draftsOf(collection: Collection): FieldDraft[] {
  return collection.fields
    .filter((f) => !f.system)
    .map((f) =>
      draft({
        name: f.name,
        type: f.type,
        required: f.required,
        last: f.type === 'autodate' && DEFAULT_LAST.has(f.name),
        options: optionsOf(f),
        original: f,
      }),
    );
}

function fieldBody(field: FieldDraft): Partial<Field> {
  if (field.original) {
    return {
      ...field.original,
      ...field.options,
      name: field.name.trim(),
      required: field.required,
    } as Partial<Field>;
  }
  const base = {
    name: field.name.trim(),
    type: field.type,
    required: field.required,
    ...field.options,
  };
  return (
    field.type === 'autodate'
      ? { ...base, onCreate: true, onUpdate: field.onUpdate ?? false }
      : base
  ) as Partial<Field>;
}

const pathOf = (collection: Pick<Collection, 'name'>) =>
  `/collections/${encodeURIComponent(collection.name)}`;

function numberText(value: unknown): string {
  return typeof value === 'number' ? String(value) : '';
}

function numberOf(text: string, empty: number | null): number | null {
  if (text.trim() === '') return empty;
  const value = Number(text);
  return Number.isFinite(value) ? value : empty;
}

const tags = (values: readonly string[]) =>
  values.map((value) => ({ id: value, label: value }));

const picked = (value: readonly { id?: string | number }[]) =>
  value.map((option) => String(option.id));

function FieldSettings({
  field,
  index,
  error,
  targets,
  onChange,
}: {
  field: FieldDraft;
  index: number;
  error: unknown;
  targets: readonly Collection[];
  onChange: (options: Options) => void;
}) {
  const { options } = field;
  const set = (key: string, value: unknown) =>
    onChange({ ...options, [key]: value });
  const at = (key: string) => errorAt(error, ['fields', index, key]);
  const number = (key: string, label: string, empty: number | null) => (
    <FormControl label={label} error={at(key)}>
      <Input
        type="number"
        value={numberText(options[key])}
        onChange={(event) =>
          set(key, numberOf(event.currentTarget.value, empty))
        }
        aria-label={`${field.name || 'Field'} ${label}`}
      />
    </FormControl>
  );
  const check = (key: string, label: string) => (
    <SettingCheck>
      <Checkbox
        checked={options[key] === true}
        onChange={(event) => set(key, event.currentTarget.checked)}
        labelPlacement={LABEL_PLACEMENT.right}
      >
        {label}
      </Checkbox>
    </SettingCheck>
  );

  switch (field.type) {
    case 'text':
      return (
        <Settings>
          {number('min', 'Min length', 0)}
          {number('max', 'Max length', 0)}
        </Settings>
      );
    case 'number':
      return (
        <Settings>
          {number('min', 'Min', null)}
          {number('max', 'Max', null)}
        </Settings>
      );
    case 'select': {
      const values = (options.values as string[] | undefined) ?? [];
      return (
        <Settings>
          <Wide>
            <FormControl
              label="Values"
              caption="Type a value and press Enter."
              error={at('values')}
            >
              <Select
                creatable
                multi
                options={tags(values)}
                value={tags(values)}
                onChange={({ value }) => set('values', picked(value))}
                aria-label={`${field.name || 'Field'} values`}
              />
            </FormControl>
          </Wide>
          {number('maxSelect', 'Max select', 1)}
        </Settings>
      );
    }
    case 'relation': {
      const target = targets.filter((c) => c.id === options.collectionId);
      return (
        <Settings>
          <FormControl label="Collection" error={at('collectionId')}>
            <Select
              options={targets.map((c) => ({ id: c.id, label: c.name }))}
              value={target.map((c) => ({ id: c.id, label: c.name }))}
              onChange={({ value }) =>
                set('collectionId', String(value[0]?.id ?? ''))
              }
              clearable={false}
              disabled={field.original !== undefined}
              aria-label={`${field.name || 'Field'} collection`}
            />
          </FormControl>
          {number('maxSelect', 'Max select', 1)}
          {check('cascadeDelete', 'Cascade delete')}
        </Settings>
      );
    }
    case 'file': {
      const mimeTypes = (options.mimeTypes as string[] | undefined) ?? [];
      const maxSize = typeof options.maxSize === 'number' ? options.maxSize : 0;
      return (
        <Settings>
          {number('maxSelect', 'Max files', 1)}
          <FormControl label="Max size (MB)" error={at('maxSize')}>
            <Input
              type="number"
              value={
                maxSize > 0
                  ? String(Math.round((maxSize / MB) * 100) / 100)
                  : ''
              }
              onChange={(event) => {
                const mb = numberOf(event.currentTarget.value, null);
                set('maxSize', mb === null ? 5 * MB : Math.round(mb * MB));
              }}
              aria-label={`${field.name || 'Field'} max size`}
            />
          </FormControl>
          <Wide>
            <FormControl
              label="MIME types"
              caption="Leave empty to allow any type."
              error={at('mimeTypes')}
            >
              <Select
                creatable
                multi
                options={tags(COMMON_MIME_TYPES)}
                value={tags(mimeTypes)}
                onChange={({ value }) => set('mimeTypes', picked(value))}
                aria-label={`${field.name || 'Field'} MIME types`}
              />
            </FormControl>
          </Wide>
          {check('protected', 'Protected')}
        </Settings>
      );
    }
    default:
      return null;
  }
}

export function CollectionForm({
  collection,
  collections = [],
  onSaved,
}: {
  collection?: Collection;
  collections?: readonly Collection[];
  onSaved: (collection: Collection) => void;
}) {
  const targets = collections.filter((c) => c.type !== 'view');
  const [name, setName] = useState(collection?.name ?? '');
  const [type, setType] = useState<Collection['type']>(
    collection?.type ?? 'base',
  );
  const [fields, setFields] = useState(() =>
    collection ? draftsOf(collection) : initialFields(),
  );
  const [viewQuery, setViewQuery] = useState(
    collection?.type === 'view' ? collection.viewQuery : '',
  );
  const snapshot = JSON.stringify({
    name,
    type,
    viewQuery,
    fields: fields.map(({ key, open, ...field }) => field),
  });
  const [initial] = useState(snapshot);
  const done = useRef(false);
  useUnsavedChanges(() => !done.current && snapshot !== initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const change = (key: string, patch: Partial<FieldDraft>) =>
    setFields((all) =>
      all.map((f) => (f.key === key ? { ...f, ...patch } : f)),
    );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const body: CollectionInput =
      type === 'view'
        ? { name: name.trim(), viewQuery }
        : { name: name.trim(), fields: fields.map(fieldBody) };
    try {
      const saved = collection
        ? await nb.collections.update(collection.id, body)
        : await nb.collections.create({ ...body, type });
      toaster.positive(
        collection ? `Saved ${saved.name}.` : `Created ${saved.name}.`,
        { key: 'collection' },
      );
      done.current = true;
      onSaved(saved);
    } catch (failure) {
      setError(failure);
      toaster.negative(
        failure instanceof ClientError && failure.status === 409
          ? failure.message
          : collection
            ? 'Failed to save the collection.'
            : 'Failed to create the collection.',
        { key: 'collection' },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title={collection ? `Edit ${collection.name}` : 'New collection'}
      icon={collection ? <EditIcon size={20} /> : <AddIcon size={20} />}
      fill
    >
      <Form onSubmit={(event) => void submit(event)} noValidate>
        <Section title="Collection">
          <Controls>
            <FormControl label="Name" error={errorAt(error, ['name'])}>
              <Input
                name="name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                autoComplete="off"
                autoFocus={!collection}
                disabled={collection?.system}
                required
              />
            </FormControl>
            <FormControl label="Type" error={errorAt(error, ['type'])}>
              <Select
                options={[...TYPES]}
                value={TYPES.filter((t) => t.id === type)}
                onChange={({ value }) => {
                  const next = value[0]?.id as Collection['type'] | undefined;
                  if (next) setType(next);
                }}
                clearable={false}
                searchable={false}
                disabled={collection !== undefined}
              />
            </FormControl>
          </Controls>
        </Section>
        {type === 'view' ? (
          <Section title="Query">
            <FormControl
              label="Select query"
              caption="The records come from this SELECT."
              error={errorAt(error, ['viewQuery'])}
            >
              <Textarea
                name="viewQuery"
                value={viewQuery}
                onChange={(event) => setViewQuery(event.currentTarget.value)}
                rows={6}
                resize="vertical"
              />
            </FormControl>
          </Section>
        ) : (
          <Section
            title="Fields"
            action={
              <Button
                type="button"
                kind={KIND.secondary}
                shape={SHAPE.square}
                size={SIZE.mini}
                aria-label="New field"
                onClick={() => setFields(withNewField)}
              >
                <AddIcon size={18} />
              </Button>
            }
          >
            <FieldList>
              <HeaderRow aria-hidden>
                <FieldRow>
                  <ColumnLabel>Name</ColumnLabel>
                  <ColumnLabel>Type</ColumnLabel>
                  <ColumnLabel $center>Required</ColumnLabel>
                </FieldRow>
              </HeaderRow>
              <List
                items={fields.map((field, i) => (
                  <FieldItem key={field.key}>
                    <FieldRow>
                      <FormControl
                        error={errorAt(error, ['fields', i, 'name'])}
                      >
                        <Input
                          value={field.name}
                          onChange={(event) =>
                            change(field.key, {
                              name: event.currentTarget.value,
                            })
                          }
                          aria-label="Field name"
                          autoComplete="off"
                        />
                      </FormControl>
                      <FormControl
                        error={errorAt(error, ['fields', i, 'type'])}
                      >
                        <Select
                          options={
                            field.original
                              ? [
                                  {
                                    id: field.type,
                                    label: FIELD_TYPE_LABELS[field.type],
                                  },
                                ]
                              : [...FIELD_TYPES]
                          }
                          value={[
                            {
                              id: field.type,
                              label: FIELD_TYPE_LABELS[field.type],
                            },
                          ]}
                          onChange={({ value }) => {
                            const next = value[0]?.id as
                              | Field['type']
                              | undefined;
                            if (next) {
                              change(field.key, {
                                type: next,
                                options: { ...DEFAULT_OPTIONS[next] },
                                open: NEEDS_SETTINGS.has(next),
                              });
                            }
                          }}
                          aria-label="Field type"
                          clearable={false}
                          searchable={false}
                          disabled={field.original !== undefined}
                        />
                      </FormControl>
                      <RowCheck>
                        <Checkbox
                          checked={field.required}
                          onChange={(event) =>
                            change(field.key, {
                              required: event.currentTarget.checked,
                            })
                          }
                          aria-label={`${field.name || 'Field'} is required`}
                        />
                      </RowCheck>
                      {SETTINGS.has(field.type) ? (
                        <Button
                          type="button"
                          kind={field.open ? KIND.primary : KIND.secondary}
                          shape={SHAPE.square}
                          aria-label={`${field.name || 'Field'} settings`}
                          aria-expanded={field.open === true}
                          onClick={() =>
                            change(field.key, { open: !field.open })
                          }
                        >
                          <TuneIcon size={18} />
                        </Button>
                      ) : (
                        <span />
                      )}
                      <Button
                        type="button"
                        kind={KIND.secondary}
                        shape={SHAPE.square}
                        aria-label={`Remove ${field.name || 'field'}`}
                        onClick={() =>
                          setFields((all) =>
                            all.filter((f) => f.key !== field.key),
                          )
                        }
                      >
                        <DeleteIcon size={18} />
                      </Button>
                    </FieldRow>
                    {field.open && (
                      <FieldSettings
                        field={field}
                        index={i}
                        error={error}
                        targets={targets}
                        onChange={(options) => change(field.key, { options })}
                      />
                    )}
                  </FieldItem>
                ))}
                onChange={({ oldIndex, newIndex }) =>
                  setFields((all) => arrayMove(all, oldIndex, newIndex))
                }
                overrides={DRAG_LIST_OVERRIDES}
              />
            </FieldList>
          </Section>
        )}
        <Actions>
          <Button
            type="button"
            kind={KIND.secondary}
            size={SIZE.default}
            onClick={() =>
              navigate(collection ? pathOf(collection) : '/collections')
            }
          >
            Cancel
          </Button>
          <Button type="submit" size={SIZE.default} isLoading={busy}>
            {collection ? 'Save' : 'Create'}
          </Button>
        </Actions>
      </Form>
    </Page>
  );
}
