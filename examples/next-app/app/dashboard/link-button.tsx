'use client';

import { ClientError } from '@nextbasejs/client';
import { useNextBase } from '@nextbasejs/react';
import { useState, useTransition } from 'react';

/** Linking adds a way into the account, so it asks for the password. */
export function LinkButton({
  collection,
  provider,
  label,
}: {
  collection: string;
  provider: string;
  label: string;
}) {
  const nb = useNextBase();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const link = () =>
    startTransition(async () => {
      const password = window.prompt('Your password, to connect it:');
      if (!password) return;
      try {
        await nb
          .collection(collection)
          .linkOAuth2(provider, { password, redirect: '/dashboard' });
      } catch (cause) {
        setError(cause instanceof ClientError ? cause.message : 'Failed.');
      }
    });
  return (
    <>
      <button type="button" disabled={pending} onClick={link}>
        Connect {label}
      </button>
      {error && <span role="alert"> {error}</span>}
    </>
  );
}
