---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

Two new field types and three new field settings. `editor` holds HTML, sanitized on the server to an allowlist of rich-text tags before it is saved, with `maxSize` (default 512 KiB) and `convertURLs`, which is stored for editors only. `geoPoint` holds `{ lon, lat }`, blank as `{ lon: 0, lat: 0 }`; filters read `field.lon` and `field.lat`, and `geoDistance(lonA, latA, lonB, latB)` gives the distance in kilometres. Every field has `presentable`, a display hint that changes nothing else. Relations have `minSelect`: at least that many ids once there are any, checked whenever the record is written. Text fields have `autogeneratePattern`, a bounded regex that generates the value of a record created without one; the system `id` and `tokenKey` fields show how theirs are made. Collections stored before these settings load with their defaults.
