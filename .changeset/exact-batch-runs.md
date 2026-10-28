---
"@nextbasejs/core": patch
---

Batch creates whose rules read other collections, such as a membership check with `@collection`, now run together too. Only creates whose create or view rule reads the collection being created run one at a time, since only those rules could see records created earlier in the same batch.
