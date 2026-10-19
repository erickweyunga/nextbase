---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
"@nextbasejs/next": patch
"@nextbasejs/react": patch
---

The server package is now `@nextbasejs/core`, replacing `nextbasejs`, so every package lives under the `@nextbasejs` scope. Install `@nextbasejs/core` and import `NextBase` from it; `@nextbasejs/next` now takes it as its peer dependency.
