import {
  ClientError,
  isMfaRequired,
  type MfaRequired,
  type RecordModel,
} from '@nextbasejs/client';
import { type FormEvent, useState } from 'react';
import { nb } from './api.ts';
import { BrandLogo } from './components/brand.tsx';
import { AuthHeading, AuthLayout } from './ui/auth-layout/index.ts';
import { Button, KIND, SIZE } from './ui/button/index.ts';
import { FormControl } from './ui/form-control/index.ts';
import { StatefulInput } from './ui/input/index.ts';
import { styled } from './ui/styles/index.ts';
import { toaster } from './ui/toast/index.ts';

const Fields = styled('form', { display: 'grid' });

const Actions = styled('div', ({ $theme }) => ({
  display: 'grid',
  gap: $theme.sizing.scale500,
  marginTop: $theme.sizing.scale300,
}));

const superusers = () => nb.collection('_superusers');

function failed(error: unknown): void {
  const message =
    error instanceof ClientError
      ? error.message
      : 'The sign-in failed. Try again.';
  toaster.negative(message, { key: 'sign-in' });
}

export function SignIn({
  email,
  onSignedIn,
}: {
  email?: string;
  onSignedIn: (record: RecordModel) => void;
}) {
  const [step, setStep] = useState<MfaRequired | undefined>();
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<{ record: RecordModel }>) => {
    setBusy(true);
    try {
      onSignedIn((await work()).record);
    } catch (error) {
      const mfa = isMfaRequired(error);
      if (mfa) setStep(mfa);
      else failed(error);
    } finally {
      setBusy(false);
    }
  };

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(() =>
      superusers().signInWithPassword(
        String(form.get('email')),
        String(form.get('password')),
        { cookie: true },
      ),
    );
  };

  const confirm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!step) return;
    const code = String(new FormData(event.currentTarget).get('code')).trim();
    const options = { mfaId: step.mfaId, cookie: true };
    void run(() =>
      /^\d{6}$/.test(code)
        ? superusers().signInWithTotp(code, options)
        : superusers().signInWithRecoveryCode(code, options),
    );
  };

  if (step) {
    return (
      <AuthLayout brand={<BrandLogo />}>
        <AuthHeading title="Two-step sign-in">
          Enter the code from your authenticator app, or a recovery code.
        </AuthHeading>
        <Fields onSubmit={confirm} noValidate>
          <FormControl label="Code">
            <StatefulInput
              name="code"
              autoComplete="one-time-code"
              placeholder="123456"
              size={SIZE.default}
              autoFocus
              required
            />
          </FormControl>
          <Actions>
            <Button type="submit" size={SIZE.default} isLoading={busy}>
              Continue
            </Button>
            <Button
              type="button"
              kind={KIND.secondary}
              size={SIZE.default}
              onClick={() => setStep(undefined)}
            >
              Back
            </Button>
          </Actions>
        </Fields>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout brand={<BrandLogo />}>
      <AuthHeading title="Sign in" />
      <Fields onSubmit={signIn} noValidate>
        <FormControl label="Email address">
          <StatefulInput
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@company.com"
            size={SIZE.default}
            initialState={{ value: email ?? '' }}
            required
          />
        </FormControl>
        <FormControl label="Password">
          <StatefulInput
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus={email !== undefined}
            placeholder="Enter your password"
            size={SIZE.default}
            required
          />
        </FormControl>
        <Actions>
          <Button type="submit" size={SIZE.default} isLoading={busy}>
            Sign in
          </Button>
        </Actions>
      </Fields>
    </AuthLayout>
  );
}
