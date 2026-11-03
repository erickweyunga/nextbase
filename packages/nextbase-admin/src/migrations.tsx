import type { MigrationModel, MigrationsStatus } from '@nextbasejs/client';
import { type ReactNode, useEffect, useState } from 'react';
import { nb } from './api.ts';
import {
  DATE_FORMAT,
  FILLER_COLUMN,
  NOWRAP_COLUMN,
} from './components/grid-columns.ts';
import { Page } from './components/page.tsx';
import { EmptyState } from './ui/empty-state/index.ts';
import { Section, SectionRow } from './ui/section/index.ts';
import { styled } from './ui/styles/index.ts';
import {
  columnOverrides,
  DIVIDER,
  TableBuilder,
  TableBuilderColumn,
} from './ui/table/index.ts';

const NAME_COLUMN = columnOverrides({ width: '280px', nowrap: true });

const Code = styled('code', ({ $theme }) => ({
  ...$theme.typography.MonoParagraphSmall,
}));

const Value = styled('span', ({ $theme }) => ({
  ...$theme.typography.ParagraphSmall,
  color: $theme.colors.contentPrimary,
}));

export function migrationState(migration: MigrationModel): string {
  if (migration.applied === null) return 'Pending';
  return migration.file ? 'Applied' : 'Applied, file removed';
}

export function Migrations({ icon }: { icon: ReactNode }) {
  const [status, setStatus] = useState<MigrationsStatus>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    nb.migrations
      .getStatus()
      .then(setStatus)
      .catch((error: unknown) =>
        setFailed(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  if (failed) {
    return (
      <Page title="Migrations" icon={icon}>
        <EmptyState icon={icon} title={failed} />
      </Page>
    );
  }

  return (
    <Page title="Migrations" icon={icon}>
      <Section title="Overview" icon={icon}>
        <SectionRow label="Folder">
          {status?.enabled ? (
            <Code>{status.dir}</Code>
          ) : (
            <Value>{status ? 'Not set up' : ''}</Value>
          )}
        </SectionRow>
        <SectionRow
          label="Automigrate"
          caption="Each collection change writes a migration."
        >
          <Value>{status && (status.automigrate ? 'On' : 'Off')}</Value>
        </SectionRow>
        <SectionRow
          label="Collection changes"
          caption="Where migrations manage collections, they change in development only."
        >
          <Value>
            {status &&
              (status.schemaChanges
                ? 'Allowed here'
                : 'Through migrations only')}
          </Value>
        </SectionRow>
      </Section>
      <TableBuilder
        data={status?.items ?? []}
        framed
        divider={DIVIDER.grid}
        pageSize={Number.MAX_SAFE_INTEGER}
        isLoading={status === undefined}
        emptyMessage={
          <EmptyState
            framed={false}
            icon={icon}
            title={
              status?.enabled
                ? 'No migrations yet'
                : 'Pass your migrations to nextbase() to track them here'
            }
          />
        }
      >
        <TableBuilderColumn<MigrationModel>
          header="Migration"
          overrides={NAME_COLUMN}
        >
          {(migration) => <Code>{migration.name}</Code>}
        </TableBuilderColumn>
        <TableBuilderColumn<MigrationModel>
          header="Applied"
          overrides={NOWRAP_COLUMN}
        >
          {(migration) =>
            migration.applied && DATE_FORMAT.format(new Date(migration.applied))
          }
        </TableBuilderColumn>
        <TableBuilderColumn<MigrationModel>
          header="Status"
          overrides={NOWRAP_COLUMN}
        >
          {migrationState}
        </TableBuilderColumn>
        <TableBuilderColumn<MigrationModel>
          header="Revertible"
          overrides={NOWRAP_COLUMN}
        >
          {(migration) => (migration.revertible ? 'Yes' : 'No')}
        </TableBuilderColumn>
        <TableBuilderColumn<MigrationModel> header="" overrides={FILLER_COLUMN}>
          {() => null}
        </TableBuilderColumn>
      </TableBuilder>
    </Page>
  );
}
