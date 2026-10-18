# @nextbase/nextbase

**Your backend, built into Next.js.** Database, authentication, file storage and
auto-generated APIs, served from your existing Next.js app at `/api/nextbase`.

> Early development. Not ready for production use.

```ts
// app/api/nextbase/[...path]/route.ts
import { NextBase } from "@nextbase/nextbase/server";

const nextbase = new NextBase();

export const { GET, POST, PATCH, DELETE } = nextbase.handlers;
```

```ts
import { NextBaseClient } from "@nextbase/nextbase/client";

const nb = new NextBaseClient();
await nb.collection("users").authWithPassword(email, password);
const posts = await nb.collection("posts").getList(1, 20, {
  filter: nb.filter("title ~ {:q}", { q }),
  expand: "author",
});
```

In server components and server actions, call the same API in-process:

```ts
const nb = nextbase.client(); // or nextbase.client({ superuser: true }) for trusted code
```

The admin UI is served at `/api/nextbase/_`.
