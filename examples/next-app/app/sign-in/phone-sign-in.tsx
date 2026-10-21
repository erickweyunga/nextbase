"use client";

import { ClientError } from "@nextbasejs/client";
import { useNextBase } from "@nextbasejs/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/** Sign-in with a code texted to a phone: number first, then the code. */
export function PhoneSignIn({ redirect }: { redirect: string }) {
  const nb = useNextBase();
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (work: () => Promise<void>) => (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      try {
        await work();
        setError(null);
      } catch (cause) {
        setError(cause instanceof ClientError ? cause.message : "Failed.");
      }
    });
  };
  const users = nb.collection("users");

  if (!sent) {
    return (
      <form
        onSubmit={run(async () => {
          await users.requestPhoneCode(phone);
          setSent(true);
        })}
      >
        <label>
          Phone number
          <input
            type="tel"
            autoComplete="tel"
            placeholder="+255712345678"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={pending}>
          Text me a code
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    );
  }
  return (
    <form
      onSubmit={run(async () => {
        await users.signInWithPhoneCode(phone, code, { cookie: true });
        router.push(redirect);
        router.refresh();
      })}
    >
      <label>
        Code sent to {phone}
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
      </label>
      <button type="submit" disabled={pending}>
        Sign in
      </button>
      <button type="button" onClick={() => setSent(false)}>
        Use another number
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
