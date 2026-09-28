---
name: pdf-assembly
description: Merge, split, rotate, stamp, watermark, compress, redact and encrypt PDFs deterministically, and fill AcroForm fields through a validated plan before flattening. Use when an existing PDF must be reshaped or a PDF form must be completed. Do not use to author a PDF from scratch, to read one, or to submit a form on a website.
license: AGPL-3.0-or-later
compatibility: qpdf, poppler-utils, ghostscript, ImageMagick and pypdf through /usr/local/lib/garden/python/bin/python3 are installed on every supported host. img2pdf is absent from openSUSE only; check it is there before rasterising, because it is what rebuilds a page without recompressing it.
allowed-tools: shell file_read file_write files_list document_read image_read publish_artifact
metadata:
  garden.tier: 'builtin'
  garden.version: '2.1.0'
  garden.risk: 'workspace'
  garden.domain: 'pdf'
---

# PDF assembly and forms

Work on copies. Never overwrite the owner's original; write to a new name and keep the input.

## Structural operations

`qpdf` is deterministic, fast, and does not re-encode content streams, so it preserves quality:

```
qpdf --empty --pages a.pdf 1-z b.pdf 1-z -- merged.pdf     # merge
qpdf in.pdf --pages . 5-12 -- extract.pdf                  # extract a range
qpdf in.pdf --pages . 1-4,9-z -- without-5-8.pdf           # drop pages
qpdf in.pdf --rotate=+90:3-5 -- rotated.pdf                # rotate a range
qpdf --split-pages in.pdf out-page.pdf                     # one file per page
qpdf --decrypt in.pdf plain.pdf                            # remove owner password
qpdf --encrypt "" ownerpw 256 --print=full -- in.pdf enc.pdf
```

Page ranges are 1-based and `z` means last. `--pages` needs the trailing `--`; without it qpdf
consumes the output name as another input.

Compression, only when a file is genuinely too large:
`gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dNOPAUSE -dBATCH -sOutputFile=small.pdf in.pdf`.
`/ebook` targets 150 dpi images. Check the result visually — `/screen` makes scans unreadable.

## Stamps and watermarks

Build the stamp as a one-page PDF with Typst, sized to the same page geometry as the target, then
overlay:

```
qpdf in.pdf --overlay stamp.pdf --repeat=1-z -- stamped.pdf
```

`--underlay` puts it behind the content, which is what a watermark usually wants so text stays
legible.

## Redaction

Drawing a black rectangle over text does **not** remove the text. It stays in the content stream
and in the extracted text. Real redaction removes the characters:

1. Rasterise the affected pages: `pdftoppm -png -r 300 -f N -l N in.pdf page`, blank the region
   with `magick page-N.png -fill black -draw 'rectangle X0,Y0 X1,Y1' page-N.png`, and rebuild that
   page with `img2pdf page-N.png -o page-N.pdf`.
2. Reassemble with qpdf.
3. **Verify**: `pdftotext redacted.pdf - | grep -i '<the redacted string>'` must return nothing.

`img2pdf` is absent on openSUSE. The opened skill tells you when a declared binary is missing; if
it does, say that real redaction is unavailable on this host rather than drawing a rectangle and
calling it redacted, because that is the failure this section exists to prevent.

Report to the owner that redacted pages became images and are no longer searchable.

## AcroForm filling

Plan, validate, fill, then flatten. Never write values straight in.

1. **Enumerate** the fields as they actually exist:
   ```python
   # /usr/local/lib/garden/python/bin/python3 enumerate_fields.py
   from pypdf import PdfReader
   fields = PdfReader('form.pdf').get_fields() or {}
   for name, f in fields.items():
       print(repr(name), f.get('/FT'), f.get('/V'), f.get('/_States_'))
   ```
   `/FT` is `/Tx` text, `/Btn` checkbox or radio, `/Ch` choice. `/_States_` lists the _only_ legal
   values for a button — usually something like `/Yes` and `/Off`, and it is often not `/Yes`.
2. **Write the plan as JSON**, field name to value, and check it against the enumeration: every key
   exists, every button value is in its `/_States_`, every choice value is in its option list, and
   no required field is missing. Report the plan to the owner before filling anything that is a
   legal declaration.
3. **Fill**, with the same interpreter:
   ```python
   from pypdf import PdfWriter
   writer = PdfWriter(clone_from='form.pdf')
   for page in writer.pages:
       writer.update_page_form_field_values(page, plan, auto_regenerate=False)
   writer.set_need_appearances_writer(True)
   ```
   Fields live on pages; iterating all pages is required for multi-page forms.
4. **Flatten only when asked**, and only after the owner has seen the filled version — flattening
   is irreversible. `qpdf --flatten-annotations=all filled.pdf flat.pdf`.
5. **Verify** by reading the values back with `PdfReader.get_fields()` _and_ by rendering the pages
   and reading them with `image_read`. A field whose value is set but whose appearance stream was
   not regenerated is invisible when printed — that is what `set_need_appearances_writer` and the
   visual check are for.

Submitting a completed form anywhere, signing it, or entering identity numbers is the owner's
action, not yours.

## Verification

- `qpdf --check out.pdf` clean.
- Page count equals the arithmetic you intended, declared as `expectPages` on the acceptance render
  clause before the merge.
- For merges, the first and last page of each source appear in the right order in the render.
- For form fills, the plan and the read-back values match exactly, and the rendered page shows the
  values.
- For redaction, the removed string is absent from `pdftotext` output.

## Failure modes

- **`--pages` without the trailing `--`.** Silently wrong output composition.
- **Black-rectangle redaction.** The most consequential mistake on this list.
- **Flattening before review.** Unrecoverable; the owner cannot correct a typo.
- **Checkbox values.** Setting `/Yes` when the form expects `/On` leaves the box unticked and the
  read-back looks fine.
- **Ghostscript compression on a scan.** `/screen` produces an unreadable document that still
  opens.
- **Losing the original.** Always write to a new file name.
