---
"@nextbasejs/core": patch
---

Strings with an unpaired UTF-16 surrogate, in any field, inside JSON or in a collection's schema, are a validation error instead of a 500 or a value silently stored with U+FFFD in its place. A `number+` or `number-` modifier that overflows to infinity is a validation error instead of a value served as null. Date fields compare their `min` and `max` by time, so years past 9999 or before 1 AD no longer pass or fail the wrong way. A cascading delete no longer fails because a record it also deletes requires one of the others, whatever the cycles or the order of the fields. Changing the password of an account with no email no longer sends an email to an empty address.
