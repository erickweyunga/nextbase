---
"@nextbasejs/core": patch
---

New auth collections' password fields default to at least 8 characters, down from 15; a field's own `min` can still ask for more. Existing collections keep the minimum they were created with.
