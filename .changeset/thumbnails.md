---
"@nextbasejs/core": patch
"@nextbasejs/client": patch
---

File fields take `thumbs`, up to 20 thumbnail sizes such as `300x200` (crop from the centre), `300x200t` and `300x200b` (from the top or bottom), `300x200f` (fit inside), `0x200` and `300x0` (one side), with sides up to 2500; `100x100` is always allowed. `GET /files/...?thumb=300x200`, or `nb.files.getUrl(record, name, { thumb })`, serves a JPEG, PNG, GIF or WebP image in that size, made with sharp on the first request, once per instance at a time, and stored beside the file under `thumbs_<name>/`, with the same access checks, cache headers and bucket redirects as the file. Thumbnails keep the image's format, are never enlarged, follow its EXIF orientation, leave out its metadata, and show the first frame of an animated GIF. Other sizes, other types of file, images that cannot be read or have more than 50 megapixels, and servers without sharp get the original file; those failures are logged as warnings with `data.type` `thumbs`. Thumbnails are deleted with their file, record or collection. sharp is an optional peer dependency of `@nextbasejs/core`: install it to make thumbnails.
