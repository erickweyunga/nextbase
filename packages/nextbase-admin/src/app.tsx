import type { RecordModel, SetupStatus } from '@nextbasejs/client';
import { type ReactNode, useEffect, useState } from 'react';
import { nb } from './api.ts';
import { Collections } from './collections.tsx';
import { Body } from './components/page.tsx';
import { Health } from './health.tsx';
import { Observability } from './observability.tsx';
import { Settings } from './settings.tsx';
import { Setup } from './setup.tsx';
import { Shell } from './shell.tsx';
import { SignIn } from './sign-in.tsx';
import { LoadingOverlay } from './ui/loading-overlay/index.ts';
import { canLeave, navigate, usePathname } from './ui/navigation.tsx';

const SUPERUSERS = '_superusers';
const LOGIN = '/login';

function page(path: string): ReactNode {
  if (path.startsWith('/observability')) {
    return <Observability path={path} />;
  }
  if (path.startsWith('/settings')) {
    return <Settings path={path} />;
  }
  if (path.startsWith('/health')) {
    return (
      <Body>
        <Health />
      </Body>
    );
  }
  return <Collections path={path} />;
}

function setupToken(path: string): string | undefined {
  const token = /^\/setup\/([^/]+)$/.exec(path)?.[1];
  return token && decodeURIComponent(token);
}

function isSetupPath(path: string): boolean {
  return path === '/setup' || path.startsWith('/setup/');
}

function redirectFor(
  path: string,
  setup: SetupStatus | undefined,
  signedIn: boolean,
): string | undefined {
  if (setup?.required) {
    if (setup.token && setupToken(path) === undefined) {
      return `/setup/${encodeURIComponent(setup.token)}`;
    }
    return isSetupPath(path) ? undefined : '/setup';
  }
  if (isSetupPath(path)) return signedIn ? '/collections' : LOGIN;
  if (path === LOGIN && signedIn) return '/collections';
  return undefined;
}

export function App() {
  const path = usePathname();
  const [superuser, setSuperuser] = useState<RecordModel | null | undefined>();
  const [setup, setSetup] = useState<SetupStatus | undefined>();
  const [createdEmail, setCreatedEmail] = useState<string>();

  useEffect(() => {
    void Promise.all([nb.setupStatus(), nb.getSession()])
      .then(([status, session]) => {
        setSetup(status);
        setSuperuser(
          session?.record.collectionName === SUPERUSERS ? session.record : null,
        );
      })
      .catch(() => setSuperuser(null));
  }, []);

  const redirect =
    superuser === undefined
      ? undefined
      : redirectFor(path, setup, superuser !== null);
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);

  const signedIn = (record: RecordModel) => {
    setSetup({ required: false });
    setSuperuser(record);
    if (path === '/' || path === LOGIN) {
      navigate('/collections', { replace: true });
    }
  };

  if (superuser === undefined || redirect) {
    return <LoadingOverlay visible label="Loading the admin" />;
  }
  if (setup?.required) {
    const token = setupToken(path);
    return (
      <Setup
        key={token}
        token={token}
        onCreated={(email) => {
          setCreatedEmail(email);
          setSetup({ required: false });
        }}
      />
    );
  }
  if (superuser === null) {
    return <SignIn email={createdEmail} onSignedIn={signedIn} />;
  }
  return (
    <Shell
      superuser={superuser}
      onSignOut={() => {
        void canLeave().then((leave) => {
          if (leave) void nb.signOut().finally(() => setSuperuser(null));
        });
      }}
    >
      {page(path)}
    </Shell>
  );
}
