---
name: pdf-extraction
description: Get text, tables and metadata out of a PDF with the page number kept attached to every extracted fact, and make scanned PDFs readable with OCR before trusting anything from them. Use when a PDF must be read, summarised, searched, or have its tables pulled into a dataset. Do not use to create, merge, split or fill PDFs, and do not use to summarise a document garden can already read through document_read when page-level provenance is not needed.
license: AGPL-3.0-or-later
compatibility: poppler-utils, garden-pdf-tables, tesseract, qpdf and /usr/local/lib/garden/python/bin/python3 are installed on every supported host. ocrmypdf is packaged only by Debian and Ubuntu, so on a Fedora, Arch or openSUSE host the OCR route is unavailable - check the binary is there before promising a searchable PDF.
allowed-tools: shell file_read file_write files_list document_read document_search image_read
metadata:
  garden.tier: 'builtin'
  garden.version: '2.0.0'
  garden.risk: 'read_only'
  garden.domain: 'pdf'
---

# PDF extraction

Every fact taken out of a PDF carries its page number from the moment it is extracted. Adding
provenance afterwards means guessing, and guessing is how a citation ends up pointing at the wrong
page.

## 1. Classify the PDF first

```
pdfinfo doc.pdf                    # pages, producer, encryption, page rotation
pdftotext -f 1 -l 3 doc.pdf - | wc -c
```

If the first three pages yield almost no characters, it is a scanned image and any "extraction"
will return nothing while appearing to succeed. Do not proceed; OCR it.

```
ocrmypdf --output-type pdfa --sidecar doc.txt --rotate-pages --deskew doc.pdf doc.ocr.pdf
```

`ocrmypdf` is packaged by Debian and Ubuntu and by no other supported family, so on a Fedora, Arch
or openSUSE host it is not there. The opened skill tells you when a declared binary is missing; if it
does, say plainly that this PDF is a scan and this computer cannot read it, rather than extracting
nothing and reporting success.

`--sidecar` writes the recognised text alongside, which is what you search. `--rotate-pages` fixes
pages scanned sideways, which otherwise OCR to noise. If ocrmypdf refuses because the file already
has a text layer, that layer is the truth — use it. Work from `doc.ocr.pdf` from then on, and say
in the answer that the source was scanned and the text is OCR output, because OCR misreads digits.

For a PDF encrypted with an owner password but readable, `qpdf --decrypt in.pdf out.pdf` produces a
working copy. A user-password-protected file needs the owner's password; ask, never attempt to
break it.

## 2. Text with page provenance

```
pdftotext -layout doc.pdf doc.txt          # whole document, layout preserved
pdftotext -layout -f 7 -l 7 doc.pdf -      # exactly page 7, to stdout
```

`-layout` preserves column and table alignment; without it a two-column paper interleaves into
nonsense. For a per-page structure that keeps provenance automatically, split on the form feed
that `pdftotext` already emits between pages:

```python
pages = open('doc.txt', encoding='utf-8').read().split('\f')
records = [{'page': i + 1, 'text': t} for i, t in enumerate(pages)]
```

Search that structure rather than a flat file, so every hit already knows its page.

## 3. Tables

`garden-pdf-tables` reads a page's word positions from poppler and recovers the grid from the
whitespace corridors that run through the rows. Ruled and unruled tables go through it the same
way; it never looks at the lines.

```
garden-pdf-tables --path doc.pdf --page 7                 # JSON: columns, rows, cells
garden-pdf-tables --path doc.pdf --page 7 --format csv    # straight to CSV
```

On a page that is only a table, that is the whole procedure — it finds the table region itself. On
a page that mixes prose and a table, or that holds two tables, scope it explicitly:

```
garden-pdf-tables --path doc.pdf --page 7 --list-rows     # every row with its top/bottom in points
garden-pdf-tables --path doc.pdf --page 7 --top 300 --bottom 520
```

Raise `--coverage 0.2` only for a table with a cell that spans columns; it lets that row intrude
into a corridor without closing it. An empty `rows` array means no consistent grid was found —
that is a real answer, not a failure to try harder: the page has no table on it, or the table needs
scoping.

Then, always:

- Check the column count of every row against the header. `"ragged": true` in the output says the
  rows disagree, which means a merged cell or a wrapped line that split; fix it before the data is
  used.
- Check that numbers parse. A column where 3 of 40 values fail to parse usually means a footnote
  marker, or a minus sign rendered as an en dash.
- Reconcile a total. If the table has a total row, sum the column and compare. This one check
  catches most extraction errors.
- Multi-page tables repeat their header. Drop repeated header rows explicitly; do not assume the
  first row of each page is data.

## 4. Reading for a question

When the goal is an answer rather than a dataset, use `document_search` to locate candidate pages
across the workspace, then `document_read` with a narrow page range for the grounded quote. Reading
a 300-page PDF into context wholesale is both expensive and worse: the answer gets diluted.

Record, per claim: file name, page number, and the quoted span of at most 25 words that supports
it. That is the input `citation-discipline` needs.

## 5. Verification

- Extracted character count is plausible for the page count — under ~200 characters per page for a
  text document means extraction failed.
- Rendered spot check: `pdftoppm -jpeg -r 120 -f N -l N doc.pdf proofs/p` on two or three pages,
  then `image_read` and compare against the extracted text for those pages. This is the only way to
  catch a systematic extraction error such as dropped superscripts or a missing column.
- Every table reconciles against its own total row, or is reported as unreconciled.
- Every quoted span is found verbatim in the extracted page text.

## Failure modes

- **Trusting a scanned PDF.** Zero characters extracted reads as an empty document, not an error.
- **Losing the page number** by concatenating pages before searching.
- **Column interleaving** from omitting `-layout` on a two-column document. The text is fluent and
  completely wrong.
- **Ligatures and hyphens.** `ﬁ` extracts as one character, and words hyphenated across a line
  break arrive split. Normalise before matching a quote.
- **Rotated pages.** Text extracts in visual order, which is not reading order. Check the page
  rotation `pdfinfo` reports.
- **Headers and footers polluting every page.** Strip the repeated first and last line before
  analysing, or every page's "confidential draft" ends up in the summary.
- **Reporting OCR output as if it were the document.** Say that it was scanned; digits are where
  OCR fails and digits are usually what matters.
