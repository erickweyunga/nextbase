---
"@nextbasejs/react": patch
---

`useRecords(collection, options)` keeps a page of records current as anyone creates, updates or deletes them, and `useRecord(collection, id, options)` one record. They subscribe first and load once the subscription is live, and again after a reset. An update or delete changes the page at once, and any change then loads it again, changes close together once, so its filter, order and count stay right. Both take `initial` from a server component for the first render, and `enabled: false`, and return `{ data, isPending, error, refetch }`.
