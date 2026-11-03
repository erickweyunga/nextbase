---
"@nextbasejs/core": patch
---

The admin can be served at a path of its own with the new `adminPath` option, such as `/admin`, from a route file there that exports `GET` of the same handler. It then answers only there, still talks to the API at `basePath`, and the setup link in the server log points to it. Without the option it stays at `<basePath>/_`.
