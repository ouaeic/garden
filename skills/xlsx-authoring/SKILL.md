---
name: xlsx-authoring
description: Build or edit .xlsx workbooks with live formulas rather than pasted values, correct number formats, named ranges and native charts using openpyxl, then force a real recalculation and assert zero error cells. Use when the deliverable is a spreadsheet, budget, financial model, tracker or Excel file, or when formulas in an existing workbook are wrong. Do not use when the deliverable is a CSV dump, a chart image, or a written report about data.
license: AGPL-3.0-or-later
compatibility: Every tool named here is installed on this computer by garden - openpyxl and pandas through /usr/local/lib/garden/python/bin/python3, plus garden-office-convert for the recalculation.
allowed-tools: shell file_read file_write files_list document_read image_read publish_artifact
metadata:
  garden.tier: 'builtin'
  garden.version: '2.0.0'
  garden.risk: 'workspace'
  garden.domain: 'spreadsheets'
---

# Spreadsheet authoring

A workbook whose derived cells hold numbers instead of formulas is a screenshot: the owner changes
an input and nothing moves. openpyxl, number formats, named ranges, freeze panes and native charts
are all things you can write already. These four are not, and each of them is the difference between
a workbook that opens and a workbook that is right.

## 1. The formulas have to be ones LibreOffice can evaluate

Verification recalculates through LibreOffice, so this is not a style preference — a formula it
cannot evaluate becomes `#NAME?`, every cell downstream of it becomes wrong, and the file still
opens perfectly.

- **Safe**: `SUM`, `SUMIFS`, `COUNTIFS`, `AVERAGEIFS`, `INDEX`, `MATCH`, `IFERROR`, `SUMPRODUCT`,
  `NPV`, `IRR`, `XNPV`, `XIRR`, `EOMONTH`, `EDATE`, `TEXT`, `ROUND`.
- **Never emit**: `XLOOKUP`, `XMATCH`, `SORT`, `SORTBY`, `FILTER`, `UNIQUE`, `SEQUENCE`, `LET`,
  `LAMBDA`, `TEXTSPLIT`. `INDEX`/`MATCH` replaces `XLOOKUP`.

Scan the workbook for that second list before converting anything. It costs nothing and saves a
round trip.

## 2. Six functions need an `_xlfn.` prefix when openpyxl writes them

`TEXTJOIN`, `CONCAT`, `IFS`, `SWITCH`, `MAXIFS`, `MINIFS`. Write `=_xlfn.TEXTJOIN(", ",TRUE,A1:A5)`
and Excel displays it correctly; write it bare and it does not survive the round trip.

## 3. Reading an existing workbook takes two passes

openpyxl gives you formulas or values, never both:

```python
formulas = load_workbook(path)                 # .value is the formula string
values   = load_workbook(path, data_only=True) # .value is the last cached result
```

## 4. `data_only=True` returns `None` for every formula cell in a file no spreadsheet has opened

That is a missing cache, not an empty sheet, and it is the single most misread state in this format.
Recalculate before believing it. (`.xlsm` has a smaller cousin: pass `keep_vba=True` on load _and_
save, or the macros are stripped without warning.)

## Recalculation, which is also the verification

openpyxl does not evaluate anything. It writes the formula string and no cached value, so a workbook
straight out of openpyxl shows blanks in some viewers until it is recalculated — and converting it
to `.xlsx` is what makes that happen:

```
garden-office-convert model.xlsx model.recalc.xlsx
/usr/local/lib/garden/python/bin/python3 scripts/count_error_cells.py model.recalc.xlsx
```

`count_error_cells.py` ships in this skill's own directory. It exits non-zero when any cell holds an
Excel error value **or** when any cell still holds a formula string with no cached result, and
prints both counts as JSON. Three things must hold:

1. `error_cells` is 0. `#REF!` is a deleted reference, `#VALUE!` a type mismatch, `#NAME?` an
   unrecognised function — which is how a forbidden modern function announces itself.
2. Every formula cell in the recalculated copy holds a value rather than `None`. `None` everywhere
   means the recalculation did not happen and the owner will open the file to blanks.
3. At least one headline number — a grand total, a margin — matches the same arithmetic done
   independently in Python from the source data. A workbook that recalculates to the wrong answer
   passes checks 1 and 2, so zero error cells means nothing broke, never that the model is right.

Then run `render-proof` on the recalculated copy and look for `#####` columns, tables split across
pages and unlabelled charts. Deliver the original formula workbook and not the recalculated copy —
but only once the copy has passed.
