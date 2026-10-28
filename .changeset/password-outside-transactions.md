---
"@nextbasejs/core": patch
---

Password changes no longer hash the new password or check the old one while the record is locked. Both now happen before the write's transaction starts. Under load, concurrent password changes could stall until the connection timeout, each holding one database connection while waiting for another; they no longer do. A caller the update rule refuses is still turned away before any password is checked or attempt counted.
