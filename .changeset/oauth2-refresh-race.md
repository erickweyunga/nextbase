---
"@nextbasejs/core": patch
---

A request that read a provider token as due no longer refreshes it a second time after another request already did: a refresh is claimed only while the stored tokens are still those the request read.
