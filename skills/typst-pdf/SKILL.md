---
name: typst-pdf
description: Typeset a precise PDF — report, letter, invoice, CV, paper, certificate — from a Typst source with real typography, page numbering and optional PDF/A conformance, then prove it renders. Use when the deliverable is a PDF authored from scratch and layout matters. Do not use to convert an existing .docx or .pptx to PDF, which goes through athanor-office-convert, and do not reach for LaTeX, which is not installed here and is not the answer to any of these.
license: AGPL-3.0-or-later
compatibility: Every tool named here is installed on this computer by athanor - typst 0.15.1, poppler-utils and qpdf.
allowed-tools: shell file_read file_write files_list image_read publish_artifact
metadata:
  athanor.tier: 'builtin'
  athanor.version: '2.3.0'
  athanor.risk: 'workspace'
  athanor.domain: 'documents'
---

# Authored PDFs with Typst

Typst is the default PDF path: one static binary, no TeX tree, deterministic output, compile times
in tens of milliseconds so iteration is cheap. Keep the `.typ` source next to the PDF — it is what
makes the document editable later.

## Document skeleton

```typst
#set document(title: "Q3 Review", author: "…")
#set page(
  paper: "a4",
  margin: (x: 2.2cm, y: 2.4cm),
  numbering: "1 / 1",
  header: context if counter(page).get().first() > 1 [#h(1fr) Q3 Review],
)
#set text(font: "Liberation Serif", size: 10.5pt, lang: "en")
#set par(justify: true, leading: 0.65em)
#show heading.where(level: 1): it => block(above: 1.6em, below: 0.8em)[
  #set text(size: 15pt, weight: 700); #it.body
]
```

- **Fonts.** `typst fonts` lists what is actually available. Naming a font that is not installed is
  a silent substitution, not an error. Liberation Serif/Sans, DejaVu and Noto are the safe set on a
  provisioned box; Carlito and Caladea are the metric-compatible stand-ins for Calibri and Cambria.
- **Page numbering** goes in `#set page(numbering: ...)`, not in a footer you draw yourself.
- **Layout primitives**: `#grid` for anything columnar (invoice line items, CV two-column layouts),
  `#table` for data with visible structure, `#stack` for vertical rhythm. `#place` only for
  genuinely absolute elements like a watermark.
- **Tables**: `#table(columns: (1fr, auto, auto), stroke: 0.5pt + gray, ...)`. Use `1fr` on the
  column that should absorb slack; `auto` everywhere else. Set `align: (left, right, right)` so
  numbers line up on the decimal.
- **Figures and references**: `#figure(image("chart.png", width: 90%), caption: [Revenue])
<rev>`, then `@rev` to reference it.
- **Bibliography**: `#bibliography("refs.bib", style: "ieee")` with `@key` citations.

## Compiling

```
typst compile report.typ report.pdf              # normal
typst compile --format png --ppi 120 report.typ proofs/p{n}.png   # direct page proofs
typst compile --pdf-standard a-3b report.typ report.pdf           # archival, embeds all fonts
```

Read the compiler's stderr every time. Two messages matter:

- **A layout convergence warning** means the layout never stabilised — usually a `1fr` inside a
  container whose size depends on its content, or a header referencing a counter it also changes.
  The PDF you get is not the document the source describes. Fix it; do not ship it.
- **A font warning** means substitution happened.

For PDF/A output, every font must be embeddable and every image must carry a colour profile;
compilation fails loudly rather than degrading, which is the behaviour you want.

## Invoices, letters and CVs

These are the cases where precision is the whole point:

- Put the data in a separate `data.yaml` or `data.json` and load it with `#let d = yaml("data.yaml")`.
  Then the same template regenerates for the next month without editing layout code.
- Currency alignment: right-align, fixed decimals, and use a monospaced or tabular-figures font for
  the totals column so digits line up between rows.
- Totals must be computed in the template from the line items, never typed. `#let total =
d.items.map(i => i.qty * i.price).sum()`.
- Keep a single page for a letter or an invoice unless the content genuinely overflows; check the
  page count in the proof.

## The one-page CV

"One page" needs a rendered page-count check. Start with readable type and useful white space;
shorten repetitive content before compressing the layout:

```typst
#set page(paper: "a4", margin: (x: 1.8cm, y: 1.6cm))
#set text(size: 10.5pt)
#set par(justify: false, leading: 0.65em)
#show heading.where(level: 1): it => block(above: 0.9em, below: 0.45em)[
  #set text(size: 14pt, weight: 700); #it.body
  #line(length: 100%, stroke: 0.6pt)
]
#grid(columns: (1fr, auto), gutter: 6pt,
  text(weight: 600)[Lead data engineer -- Meridian Financial],
  text(size: 8.6pt)[2021 -- present],
)
#list(tight: true, spacing: 0.42em, [...], [...])
```

`#grid` with a `1fr` first column and `auto` second aligns role dates at the right margin.
Give every multi-row grid explicit spacing, including contact details: for example,
`row-gutter: 4pt, column-gutter: 12pt`. Paragraph leading does not space separate grid cells.
Inspect the contact block at readable scale; email, location and wrapped authorization text must
not touch the row above. Do not use negative vertical spacing to force content onto a page.

Keep salary, availability and personal declarations in the application fields unless the owner
asks for them on the CV. Omit unsupported achievements, unnamed institutions and irrelevant
negative statements about qualifications the applicant does not hold.

Declare `expectPages: 1` on the acceptance render clause before you compile. If the harness reports
2, cut content — do not drop below 9pt, and do not shrink the margins under 1.4cm, because both
produce a CV that reads as though it was squeezed.
Cut the oldest role's bullets first.

**Escape the `@`.** In Typst markup `@` starts a reference, so `candidate@example.org` fails to
compile with "label does not exist". Write `candidate\@example.org`. Every CV has an email address
on it, so this is the first error you will hit.

## Verification

1. `typst compile` exits 0 with no warnings on stderr.
2. `qpdf --check report.pdf` reports no errors.
3. `pdffonts report.pdf` — every font shows `emb yes`.
4. `pdftoppm -jpeg -r 120` and `image_read` each page: no overflowing table, no orphaned heading,
   no widow line, page numbers present and correct.
5. `pdftotext report.pdf - | grep -n -E '\bTODO\b|\bLorem\b|\{\{|\bNone\b|\bnan\b|\bNaN\b'`. Keep
   the word boundaries: bare `none` and `nan` match ordinary prose — "none of the above",
   "finance" — and a placeholder scan that fires on every document is one nobody reads.
6. For an invoice or a financial document, recompute the total by hand from the line items and
   compare against the printed total.

## Failure modes

- **A font that is not installed.** The output looks plausible and is wrong. `typst fonts` first.
- **Ignoring a convergence warning.** It is the one diagnostic that means "this output is not
  deterministic".
- **Hardcoding a total.** The line items change and the total does not; nothing catches it because
  the PDF is valid.
- **Reaching for LaTeX or Pandoc by habit.** Neither is installed here and neither should be. Typst
  is the PDF path on this computer; an existing `.tex` tree is the only case that would ever need
  another, and that is a conversation with the owner, not an install.
- **Writing HTML and printing it.** `print_pdf` is an HTML-to-PDF path and it is the right one for
  keeping a page that already exists - a job posting, a receipt, a statement. It is the wrong one
  for a deliverable you are authoring, because nothing in it controls where the pages break. That
  control is the reason a CV, a letter or an invoice is typeset here.
- **Not declaring the page limit as `expectPages`.** A CV, a one-pager, a covering letter and
  an abstract all have one, and the compiler is perfectly happy to exceed it.
