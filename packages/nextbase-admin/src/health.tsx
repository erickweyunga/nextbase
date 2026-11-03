import { useEffect, useState } from 'react';
import { apiUrl } from './api.ts';
import { Page } from './components/page.tsx';
import { WifiIcon } from './ui/icons/index.tsx';
import { Section, SectionRow } from './ui/section/index.ts';
import { SIZE, Spinner } from './ui/spinner/index.ts';
import { KIND, Tag } from './ui/tag/index.ts';

export function Health() {
  const [status, setStatus] = useState<'checking' | 'ok' | string>('checking');

  useEffect(() => {
    void fetch(apiUrl('health'))
      .then((response) =>
        setStatus(response.ok ? 'ok' : `error ${response.status}`),
      )
      .catch(() => setStatus('unreachable'));
  }, []);

  return (
    <Page title="Health" icon={<WifiIcon size={20} />}>
      <Section title="Server" icon={<WifiIcon size={20} />}>
        <SectionRow label="Status">
          {status === 'checking' ? (
            <Spinner $size={SIZE.small} />
          ) : (
            <Tag kind={status === 'ok' ? KIND.green : KIND.red}>{status}</Tag>
          )}
        </SectionRow>
      </Section>
    </Page>
  );
}
