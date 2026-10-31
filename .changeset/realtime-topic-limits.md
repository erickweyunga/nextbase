---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
"@nextbasejs/react": patch
---

A realtime stream over 50 topics, or over the weight of 100, now refuses only the topics past the limit, so the client ends just those subscriptions and keeps the rest. The client shares one topic between identical subscriptions. `useRecords` reloads during a steady stream of changes instead of waiting for a pause, and no longer patches the wrong item when `fields` leaves out `id`.
