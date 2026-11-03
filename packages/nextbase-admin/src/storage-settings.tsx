import type { SettingsModel, StorageSettings } from '@nextbasejs/client';
import type { ReactNode } from 'react';
import {
  Code,
  Hint,
  SettingsPage,
  Value,
  ValueCode,
} from './settings-page.tsx';
import { Section, SectionRow } from './ui/section/index.ts';

type Bucket = Extract<StorageSettings, { kind: 's3' }>;

function LocalRows({ dir }: { dir: string }) {
  return (
    <>
      <SectionRow label="Kept in">
        <Value>The server's disk</Value>
      </SectionRow>
      <SectionRow
        label="Folder"
        caption={
          <>
            Serverless hosts lose local files: use a bucket there.{' '}
            <Code>storage.dir</Code>
          </>
        }
      >
        <ValueCode>{dir}</ValueCode>
      </SectionRow>
    </>
  );
}

function BucketRows({ bucket }: { bucket: Bucket }) {
  return (
    <>
      <SectionRow
        label="Kept in"
        caption="Files over 4 MB upload straight to the bucket."
      >
        <Value>An S3-compatible bucket</Value>
      </SectionRow>
      <SectionRow label="Bucket" caption={<Code>storage.s3.bucket</Code>}>
        <ValueCode>{bucket.bucket}</ValueCode>
      </SectionRow>
      <SectionRow label="Region" caption={<Code>storage.s3.region</Code>}>
        <ValueCode>{bucket.region}</ValueCode>
      </SectionRow>
      <SectionRow label="Endpoint" caption={<Code>storage.s3.endpoint</Code>}>
        {bucket.endpoint ? (
          <ValueCode>{bucket.endpoint}</ValueCode>
        ) : (
          <Value>AWS</Value>
        )}
      </SectionRow>
      <SectionRow
        label="Addressing"
        caption={<Code>storage.s3.forcePathStyle</Code>}
      >
        <Value>
          {bucket.forcePathStyle
            ? 'Path style, endpoint/bucket'
            : 'Virtual-hosted, bucket.endpoint'}
        </Value>
      </SectionRow>
      <SectionRow
        label="Credentials"
        caption="The keys themselves are never shown."
      >
        <Value>
          {bucket.credentials === 'keys'
            ? 'Access keys in the option'
            : "The AWS SDK's own sources"}
        </Value>
      </SectionRow>
    </>
  );
}

export function StorageSettingsPage({
  settings,
  failed,
  icon,
}: {
  settings: SettingsModel | undefined;
  failed: string | undefined;
  icon: ReactNode;
}) {
  const storage = settings?.storage;
  return (
    <SettingsPage title="File storage" icon={icon} failed={failed}>
      <Section title="File storage" icon={icon}>
        <Hint>
          Set with the <Code>storage</Code> option of <Code>nextbase()</Code>.
        </Hint>
        {storage?.kind === 'local' && <LocalRows dir={storage.dir} />}
        {storage?.kind === 's3' && <BucketRows bucket={storage} />}
      </Section>
    </SettingsPage>
  );
}
