---
"@nextbasejs/core": patch
---

- Deleting a record with cascades takes a few queries per level of related records, however many records there are. Deleting a thread with 30 replies and 60 likes went from 158 queries to 11.
- Updating a record no longer blocks requests that create or change records referencing it, such as adding a comment to a post being edited.
