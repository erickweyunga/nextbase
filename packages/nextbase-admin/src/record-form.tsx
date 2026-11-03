import type { Collection, Field, RecordModel } from '@nextbasejs/client';
import { type FormEvent, useId, useRef, useState } from 'react';
import { nb } from './api.ts';
import { DATE_FORMAT } from './components/grid-columns.ts';
import { errorAt } from './errors.ts';
import {
  FileInput,
  type FileValue,
  fileBody,
  RelationInput,
  type RelationOption,
  relationOptions,
} from './field-inputs.tsx';
import { asList } from './record-text.ts';
import { Accordion, Panel } from './ui/accordion/index.ts';
import { Button } from './ui/button/index.ts';
import { Checkbox, LABEL_PLACEMENT } from './ui/checkbox/index.ts';
import { FormControl } from './ui/form-control/index.ts';
import { AddIcon, EditIcon } from './ui/icons/index.tsx';
import { Input } from './ui/input/index.ts';
import { canLeave } from './ui/navigation.tsx';
import { COUNTRIES, PhoneInput } from './ui/phone-input/index.ts';
import { Select } from './ui/select/index.ts';
import { SidePanel } from './ui/side-panel/index.ts';
import { styled } from './ui/styles/index.ts';
import { Textarea } from './ui/textarea/index.ts';
import { toaster } from './ui/toast/index.ts';
import { useUnsavedChanges } from './unsaved.ts';

type Values = Record<string, unknown>;

type PhoneCountry = (typeof COUNTRIES)[keyof typeof COUNTRIES];

interface PhoneEntry {
  country: PhoneCountry;
  text: string;
}

function countryOf(id: string | undefined): PhoneCountry | undefined {
  return Object.values(COUNTRIES).find((c) => c.id === id?.toUpperCase());
}

function browserCountry(): PhoneCountry {
  const region = new Intl.Locale(navigator.language).maximize().region;
  return countryOf(region) ?? COUNTRIES.US;
}

function phoneEntry(value: unknown): PhoneEntry {
  const phone = typeof value === 'string' ? value : '';
  const country = Object.values(COUNTRIES)
    .filter((c) => phone.startsWith(c.dialCode))
    .sort((a, b) => b.dialCode.length - a.dialCode.length)[0];
  return country
    ? { country, text: phone.slice(country.dialCode.length).trim() }
    : { country: browserCountry(), text: phone };
}

function phoneValue({ country, text }: PhoneEntry): string {
  const typed = text.trim();
  if (typed === '') return '';
  return typed.startsWith('+') ? typed : `${country.dialCode} ${typed}`;
}

const EDITABLE = new Set<Field['type']>([
  'text',
  'number',
  'bool',
  'email',
  'phone',
  'url',
  'date',
  'select',
  'relation',
  'file',
  'json',
  'password',
]);

const INPUT_TYPES: Partial<Record<Field['type'], string>> = {
  number: 'number',
  email: 'email',
  url: 'url',
  date: 'datetime-local',
  password: 'password',
};

const Fields = styled('div', ({ $theme }) => ({
  display: 'grid',
  rowGap: $theme.sizing.scale300,
}));

function editableFields(collection: Collection): Field[] {
  return collection.fields.filter(
    (f) =>
      EDITABLE.has(f.type) &&
      f.name !== 'id' &&
      (!f.hidden || f.type === 'password'),
  );
}

function isoToLocal(value: unknown): string {
  const date = new Date(String(value));
  if (value === '' || Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function initialValue(
  field: Field,
  collections: readonly Collection[],
  record?: RecordModel,
): unknown {
  const value = record?.[field.name];
  switch (field.type) {
    case 'relation':
      return relationOptions(
        field,
        collections.find((c) => c.id === field.collectionId),
        record,
      );
    case 'file':
      return { kept: asList(value), added: [] } satisfies FileValue;
    case 'bool':
      return value === true;
    case 'select':
      return (Array.isArray(value) ? value : [value]).filter(
        (v): v is string => typeof v === 'string' && v !== '',
      );
    case 'phone':
      return phoneEntry(value);
    case 'date':
      return isoToLocal(value);
    case 'json':
      return value === null || value === undefined || value === ''
        ? ''
        : JSON.stringify(value, null, 2);
    case 'password':
      return '';
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

function localToIso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function recordBody(
  fields: readonly Field[],
  values: Values,
  editing: boolean,
): Values {
  const body: Values = {};
  for (const field of fields) {
    const value = values[field.name];
    switch (field.type) {
      case 'bool':
        body[field.name] = value === true;
        break;
      case 'number':
        if (value !== '') body[field.name] = Number(value);
        else if (editing) body[field.name] = null;
        break;
      case 'date':
        if (value !== '') body[field.name] = localToIso(String(value));
        else if (editing) body[field.name] = '';
        break;
      case 'select': {
        const picked = value as string[];
        body[field.name] = field.maxSelect > 1 ? picked : (picked[0] ?? '');
        break;
      }
      case 'relation': {
        const picked = (value as RelationOption[]).map((option) => option.id);
        body[field.name] = field.maxSelect > 1 ? picked : (picked[0] ?? '');
        break;
      }
      case 'file':
        body[field.name] = fileBody(field, value as FileValue);
        break;
      case 'json':
        if (value !== '') body[field.name] = JSON.parse(String(value));
        else if (editing) body[field.name] = null;
        break;
      case 'password':
        if (value !== '') {
          body[field.name] = value;
          body[`${field.name}Confirm`] = values[`${field.name}Confirm`];
        }
        break;
      case 'phone': {
        const phone = phoneValue(value as PhoneEntry);
        if (phone !== '' || editing) body[field.name] = phone;
        break;
      }
      default:
        if (value !== '' || editing) body[field.name] = value;
    }
  }
  return body;
}

export function RecordPanel({
  collection,
  collections,
  record,
  onClose,
  onSaved,
}: {
  collection: Collection;
  collections: readonly Collection[];
  record?: RecordModel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const formId = useId();
  const fields = editableFields(collection);
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(
      fields.flatMap((f) => [
        [f.name, initialValue(f, collections, record)],
        ...(f.type === 'password' ? [[`${f.name}Confirm`, '']] : []),
      ]),
    ),
  );
  const [initial] = useState(() => JSON.stringify(values));
  const saved = useRef(false);
  useUnsavedChanges(() => !saved.current && JSON.stringify(values) !== initial);
  const close = () =>
    void canLeave().then((leave) => {
      if (leave) onClose();
    });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const set = (name: string, value: unknown) =>
    setValues((current) => ({ ...current, [name]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let body: Values;
    try {
      body = recordBody(fields, values, record !== undefined);
    } catch {
      toaster.negative('A JSON field is not valid JSON.', { key: 'record' });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const records = nb.collection(collection.name);
      if (record) await records.update(record.id, body);
      else await records.create(body);
      toaster.positive(record ? 'Saved the record.' : 'Created the record.', {
        key: 'record',
      });
      saved.current = true;
      onSaved();
    } catch (failure) {
      setError(failure);
      toaster.negative(
        record ? 'Failed to save the record.' : 'Failed to create the record.',
        { key: 'record' },
      );
    } finally {
      setBusy(false);
    }
  };

  const control = (field: Field) => {
    const value = values[field.name];
    const text = String(value ?? '');
    const onText = (next: string) => set(field.name, next);
    switch (field.type) {
      case 'bool':
        return (
          <Checkbox
            checked={value === true}
            onChange={(event) => set(field.name, event.currentTarget.checked)}
            labelPlacement={LABEL_PLACEMENT.right}
          >
            {field.name}
          </Checkbox>
        );
      case 'select':
        return (
          <Select
            options={field.values.map((v) => ({ id: v, label: v }))}
            value={(value as string[]).map((v) => ({ id: v, label: v }))}
            onChange={({ value: picked }) =>
              set(
                field.name,
                picked.map((option) => String(option.id)),
              )
            }
            multi={field.maxSelect > 1}
            required={field.required}
            aria-label={field.name}
          />
        );
      case 'relation':
        return (
          <RelationInput
            field={field}
            target={collections.find((c) => c.id === field.collectionId)}
            value={value as RelationOption[]}
            onChange={(next) => set(field.name, next)}
          />
        );
      case 'file':
        return (
          <FileInput
            field={field}
            {...(record && { record })}
            value={value as FileValue}
            onChange={(next) => set(field.name, next)}
          />
        );
      case 'json':
        return (
          <Textarea
            value={text}
            onChange={(event) => onText(event.currentTarget.value)}
            rows={4}
            required={field.required}
            resize="vertical"
          />
        );
      case 'phone': {
        const phone = value as PhoneEntry;
        return (
          <PhoneInput
            country={phone.country}
            text={phone.text}
            onCountryChange={({ option }) => {
              const country = countryOf(String(option?.id));
              if (country) set(field.name, { ...phone, country });
            }}
            onTextChange={(event) =>
              set(field.name, { ...phone, text: event.target.value })
            }
            required={field.required}
            overrides={{ Input: { props: { 'aria-label': field.name } } }}
          />
        );
      }
      default:
        return (
          <Input
            type={INPUT_TYPES[field.type] ?? 'text'}
            value={text}
            onChange={(event) => onText(event.currentTarget.value)}
            required={field.required && !(record && field.type === 'password')}
            autoComplete={field.type === 'password' ? 'new-password' : 'off'}
          />
        );
    }
  };

  const row = (field: Field) =>
    field.type === 'bool' ? (
      <FormControl key={field.id} error={errorAt(error, [field.name])}>
        {control(field)}
      </FormControl>
    ) : (
      [
        <FormControl
          key={field.id}
          label={field.name}
          error={errorAt(error, [field.name])}
        >
          {control(field)}
        </FormControl>,
        field.type === 'password' && (
          <FormControl
            key={`${field.id}-confirm`}
            label={`${field.name}Confirm`}
            error={errorAt(error, [`${field.name}Confirm`])}
          >
            <Input
              type="password"
              value={String(values[`${field.name}Confirm`] ?? '')}
              onChange={(event) =>
                set(`${field.name}Confirm`, event.currentTarget.value)
              }
              autoComplete="new-password"
              required={field.required && !record}
            />
          </FormControl>
        ),
      ]
    );

  const groups = [
    {
      key: 'record',
      title: 'Record',
      fields: fields.filter((f) => !f.system && f.type !== 'password'),
    },
    {
      key: 'account',
      title: 'Account',
      fields: fields.filter((f) => f.system && f.type !== 'password'),
    },
    {
      key: 'password',
      title: 'Password',
      fields: fields.filter((f) => f.type === 'password'),
    },
  ];
  const autodates = collection.fields.filter((f) => f.type === 'autodate');

  return (
    <SidePanel
      title={record ? 'Edit record' : 'New record'}
      icon={record ? <EditIcon size={20} /> : <AddIcon size={20} />}
      onClose={close}
      footer={
        <Button type="submit" form={formId} isLoading={busy}>
          {record ? 'Save' : 'Create'}
        </Button>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} noValidate>
        <Accordion
          initialState={{
            expanded: ['record', 'account', 'password', 'details'],
          }}
        >
          {groups
            .filter((group) => group.fields.length > 0)
            .map((group) => (
              <Panel key={group.key} title={group.title}>
                <Fields>{group.fields.map(row)}</Fields>
              </Panel>
            ))}
          {record && (
            <Panel key="details" title="Details">
              <Fields>
                <FormControl label="Record id">
                  <Input value={record.id} disabled />
                </FormControl>
                {autodates.map((field) => (
                  <FormControl key={field.id} label={field.name}>
                    <Input
                      value={
                        record[field.name]
                          ? DATE_FORMAT.format(
                              new Date(String(record[field.name])),
                            )
                          : ''
                      }
                      disabled
                    />
                  </FormControl>
                ))}
              </Fields>
            </Panel>
          )}
        </Accordion>
      </form>
    </SidePanel>
  );
}
