# NextBase

**Your backend, built into Next.js.**

NextBase is a lightweight, open-source backend toolkit that brings database
management, authentication, file storage and automatically generated APIs
directly into Next.js applications. It removes the need to deploy and maintain a separate backend server: install the package, point it
at Postgres, and your app serves a complete backend at `/api/nextbase`.

**One package. One application. One deployment.**

> Early development. Documentation: [nextbase.dev](https://nextbase.dev).

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/nextbase-core` | `@nextbasejs/core`: the backend and the `nextbase` CLI, for any framework that speaks web-standard `Request`/`Response` |
| `packages/nextbase-client` | `@nextbasejs/client`: the SDK and the wire types shared with the server |
| `packages/nextbase-next` | `@nextbasejs/next`: route handlers and a server client for Next.js |
| `packages/nextbase-react` | `@nextbasejs/react`: provider and hooks |
| `packages/nextbase-admin` | Private admin UI, built to one HTML file and embedded into the server bundle |
| `packages/nextbase-dbx` | Private Postgres query builder and data access layer, bundled into the server |
| `examples/next-app` | Next.js app wired to the package; used for manual and end-to-end testing |

## Development

Requires Node 24 (see `.nvmrc`) and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm dev        # watch-builds the packages and runs the example at http://localhost:3000
pnpm check      # lint, typecheck, test, build, package validation, knip (what CI runs)
pnpm format     # apply Biome formatting and import sorting
```

Releases use [Changesets](https://github.com/changesets/changesets): run
`pnpm changeset` in any PR that changes a published package. The four are versioned together (a
Changesets `fixed` group). Merging to `main`
opens a "Version packages" PR; merging that publishes to npm.
