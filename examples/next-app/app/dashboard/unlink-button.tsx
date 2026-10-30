'use client';

import { ClientError } from '@nextbasejs/client';
import { useNextBase } from '@nextbasejs/react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export function UnlinkButton({
  collection,
  recordId,
  provider,
}: {
  collection: string;
  recordId: string;
  provider: string;
}) {
  const nb = useNextBase();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const unlink = () =>
    startTransition(async () => {
      // Removing a way in asks for the password too.
      const password = window.prompt('Your password, to unlink it:');
      if (!password) return;
      try {
        await nb
          .collection(collection)
          .unlinkAccount(recordId, provider, { password });
        setError(null);
        router.refresh();
      } catch (cause) {
        setError(cause instanceof ClientError ? cause.message : 'Failed.');
      }
    });
  return (
    <>
      <button type="button" disabled={pending} onClick={unlink}>
        Unlink
      </button>
      {error && <span role="alert"> {error}</span>}
    </>
  );
}
