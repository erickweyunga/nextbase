---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

The admin at `<basePath>/_` is now an app, in a light or dark theme that follows the system unless the superuser picks one.

- **Setup and sign-in.** While no superuser exists, the server log prints a link to the setup screen, `<appUrl><basePath>/_/#/setup/<token>`, which creates the first superuser and then opens the sign-in page with its email filled in. In development, `GET /setup` also answers the token (`SetupStatus.token`), so the admin opens that screen on its own. Sign-in takes the code of an authenticator app when the account has one.
- **Collections.** A menu lists the app's collections and, folded, the system ones, with a search. Opening Collections returns to the last collection viewed, or the first. New collection creates a base, auth or view collection with its fields, which can be reordered by dragging, or its query; Edit collection renames it and its fields and changes their order.
- **Records.** A collection opens as a table of its records, a page at a time, with search or a filter expression. New record and a click on a row open a panel to create or edit a record, its fields grouped into sections; selected records can be deleted.
- **Observability.** Events is the server's log as a table, newest first and loading more as it scrolls, with errors and warnings highlighted and a panel with each event's details. Analytics compares requests, errors, warnings and the error rate with the previous period, over the last 24 hours, 3 days or 7 days.
