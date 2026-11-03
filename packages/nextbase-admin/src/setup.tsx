import { ClientError } from '@nextbasejs/client';
import { type FormEvent, useState } from 'react';
import { nb } from './api.ts';
import { BrandLogo } from './components/brand.tsx';
import { AuthHeading, AuthLayout } from './ui/auth-layout/index.ts';
import { Button, SIZE } from './ui/button/index.ts';
import { FormControl } from './ui/form-control/index.ts';
import { StatefulInput } from './ui/input/index.ts';
import { styled } from './ui/styles/index.ts';
import { toaster } from './ui/toast/index.ts';

const Fields = styled('form', { display: 'grid' });

const Actions = styled('div', ({ $theme }) => ({
  display: 'grid',
  marginTop: $theme.sizing.scale300,
}));

function fieldError(error: unknown, field: string): string | undefined {
  if (!(error instanceof ClientError)) return undefined;
  if (field === 'token' && error.status === 403) return error.message;
  const message = (error.data[field] as { message?: unknown } | undefined)
    ?.message;
  return typeof message === 'string' ? message : undefined;
}

export function Setup({
  token,
  onCreated,
}: {
  token: string | undefined;
  onCreated: (email: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    if (password !== String(form.get('passwordConfirm'))) {
      toaster.negative('The passwords do not match.', { key: 'setup' });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await nb.setup({
        token: String(form.get('token')).trim(),
        email,
        password,
      });
      toaster.positive('NextBase is set up. Sign in to continue.', {
        key: 'setup',
      });
      onCreated(email);
    } catch (failure) {
      setError(failure);
      toaster.negative('Failed to complete setup.', { key: 'setup' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout brand={<BrandLogo />}>
      <AuthHeading title="Set up NextBase">
        {!token &&
          'Open the setup link from the server log, or paste its token below.'}
      </AuthHeading>
      <Fields onSubmit={(event) => void submit(event)} noValidate>
        <FormControl label="Setup token" error={fieldError(error, 'token')}>
          <StatefulInput
            name="token"
            autoComplete="off"
            size={SIZE.default}
            initialState={{ value: token ?? '' }}
            required
          />
        </FormControl>
        <FormControl label="Email address" error={fieldError(error, 'email')}>
          <StatefulInput
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@company.com"
            size={SIZE.default}
            autoFocus
            required
          />
        </FormControl>
        <FormControl label="Password" error={fieldError(error, 'password')}>
          <StatefulInput
            name="password"
            type="password"
            autoComplete="new-password"
            size={SIZE.default}
            required
          />
        </FormControl>
        <FormControl label="Confirm password">
          <StatefulInput
            name="passwordConfirm"
            type="password"
            autoComplete="new-password"
            size={SIZE.default}
            required
          />
        </FormControl>
        <Actions>
          <Button type="submit" size={SIZE.default} isLoading={busy}>
            Set up
          </Button>
        </Actions>
      </Fields>
    </AuthLayout>
  );
}
