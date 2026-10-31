import type { AuthStore } from './auth-store.ts';

/**
 * Keeps overlapping requests from saving older state over newer. A refresh saves only
 * if the store is unchanged; a sign-in or sign-out wins unless a later one already did.
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
