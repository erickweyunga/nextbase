import type { AuthStore } from "./auth-store.ts";

/**
 * Keeps requests that overlap from saving an older state over a newer one.
 * A refresh of the current session, such as `getSession`, saves its answer
 * only if the store did not change while it was in flight. A sign-in or
 * sign-out is what the user asked for last, so it changes the store unless
 * one started after it already did.
 */
class AuthSync {
  // Bumped on every change of the store, including from another tab.
  #version = 0;
  // Sign-ins and sign-outs, numbered in the order they started.
  #started = 0;
  // The latest of them that changed the store.
  #applied = 0;

  constructor(store: AuthStore) {
    store.onChange(() => {
      this.#version++;
    });
  }

  /** Returns a function that tells whether the store is unchanged since now. */
  snapshot(): () => boolean {
    const version = this.#version;
    return () => this.#version === version;
  }

  /**
   * Starts a sign-in or sign-out. The returned function runs `change` unless
   * one started later has already changed the store.
   */
  intent(): (change: () => void) => void {
    const number = ++this.#started;
    return (change) => {
      if (number < this.#applied) return;
      this.#applied = number;
      change();
    };
  }
}

// One per store, as clients may share a store.
const syncs = new WeakMap<AuthStore, AuthSync>();

export function authSync(store: AuthStore): AuthSync {
  let sync = syncs.get(store);
  if (!sync) {
    sync = new AuthSync(store);
    syncs.set(store, sync);
  }
  return sync;
}
