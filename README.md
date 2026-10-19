# CCS / MS4 Price Upload Tool

A local web app that takes one Excel price file and produces the CCS and MS4
upload files from it. Everything runs on your machine; nothing leaves it.

## Running it

Double-click `start.bat`. It installs the Python dependencies the first time,
starts the server on `http://127.0.0.1:8765` and opens your browser.

The **Log out** icon in the top right shuts the server down.

Requirements: Python 3.10+ on PATH. Dependencies are in `requirements.txt`
(FastAPI, uvicorn, python-multipart, openpyxl).

## What it does

1. **Upload** an Excel file. The tool looks for `HP P/N`, `Buy Price`,
   `Sell Price` and `ESC`. Any column it cannot find is asked for in a mapping
   dialog, where each source column can only be used once.
2. **Vendor matching.** The character at a rule's position within the three
   characters after the `-` in the part number (for `Q12345-S23`, position 1 is
   `S`, position 2 is `2`) is looked up in the HPPN / Vendor Map. The map may
   hold rules at different positions, so a part number can match more than one;
   when that happens the tool lists those part numbers and asks which rule to
   use for each, with a "prefer position N - apply to all" shortcut. The choice
   is stored with the data and reused later. If a part number ends up without
   both an MS4 vendor code and a vendor code, a scrollable list of the
   offenders is shown and nothing is loaded.
3. **Pick rows** in the main table. Search filters every column as you type.
   Select all with the header checkbox, ctrl-click to toggle one row,
   shift-click to take a range.
4. **Generate.** The CCS and MS4 action bars appear once something is selected.

## Outputs

| Action | Template | File |
|---|---|---|
| Generate CCS price upload excel | CCS upload template.xlsx | `CCS price upload_YYYYMMDD.xlsx` |
| Generate CNP to Y | CNP to Y.xlsx | `CNP to Y_YYYYMMDD.xlsx` |
| Generate Site Extend excel | Vendor Activate.xlsx | `Vendor Activate_YYYYMMDD.xlsx` |
| Generate MS4 buy price excel | Buy Template.csv | `MS4 buy price upload_YYYYMMDD.csv` |
| Generate sell price excel | Sell Template.txt | `MS4 sell price upload_YYYYMMDD.txt` |
| Generate ESC price excel | Standard Template.csv | `MS4 ESC price upload_YYYYMMDD.csv` |
| Generate all | all three MS4 templates | `MS4 upload_YYYYMMDD.zip` |

`YYYYMMDD` is today's date.

### Rules the generators follow

- **CCS price upload** - each part becomes six lines: two vendors (MS4 vendor
  code first, then the vendor code) times three price types
  (Sell `NH`/`C`, Buy `NB`/`C`, ESC `NB`/`F`). `Site` is `CORP`, `Cost` is a
  number, `Eff From Date` is a real date cell carrying the template's own
  `mm-dd-yy` format. Everything else is left blank.
- **MS4 vendor code in CCS files** gets one extra leading zero
  (`123456789` -> `0123456789`). The plain vendor code is written as entered.
  MS4 files use both codes exactly as entered.
- **Site Extend** writes two lines per part per assigned site.
- **MS4 buy** writes one line per part per assigned plant; the Purchase Org
  comes from the plant. **ESC** is always `HCW1` / `WCMP`.
- Validity end date is always `99991231`, currency `USD`, price unit `1`,
  Info Record Category `0`, Condition type `PB00`.
- A Buy Price, Sell Price or ESC that is blank or non-numeric **blocks**
  generation and is listed in a dialog.

## Settings (gear icon)

- **HPPN / Vendor Map** - alphabet, position, supplier name, MS4 vendor code,
  vendor code. Rules may use different positions, and the same letter may
  appear once per position. Only the same letter *and* position twice is
  refused. Changing the map after data is loaded can create a new ambiguity;
  the next generate then asks which rule to use and carries on.
  **Download template** gives you a blank workbook with the right headings;
  **Import data** reads a filled-in one. (Sites and plants have the same pair.) The import first shows what it would
  do - how many rows are new, how many already exist, and any rows it cannot
  use - and then offers **Merge** (update rules that match on letter and
  position, add the rest) or **Replace all** (wipe the map first). Rows with a
  bad alphabet, a position outside 1-3, or the same letter and position listed
  twice block the import; a row missing a vendor code is allowed but flagged.
  All three importers work the same way: preview first, then Merge or Replace
  all, and nothing is written while the file still has errors.
- **CCS Templates** / **MS4 Templates** - download, replace or reset each
  template. Replacements are stored in the database and used from then on.
- **Add CCS Sites** - the sites offered when assigning Site Extend. Same
  **Download template** / **Import data** pair; site codes are compared
  without case and each may appear once.
- **MS4 Add Plant** - plant, Purchase Org and region. A plant belongs to one
  Purchase Org; a Purchase Org can have many plants. Duplicate plants are
  refused. Also has **Download template** / **Import data**; merging updates
  the Purchase Org and region of plants already listed.
- **Generation history** - what was produced, when, and how many rows.
- **Dark mode** - toggle; dark is the default.

## Layout

```
app/
  main.py            FastAPI routes
  db.py              SQLite schema and helpers
  ingest.py          workbook parsing, column mapping, vendor resolution
  template_store.py  templates kept as blobs in the database
  generators/        common.py, ccs.py, ms4.py
static/              index.html, css/, js/ (no build step)
templates_seed/      the shipped copies of the six templates
data/app.db          created on first run
```

`data/app.db` holds the vendor map, sites, plants, templates, the most recent
upload (including which rule was chosen for each part number) and the
generation history. Delete it to start from scratch. A database made by an
older build is migrated on startup, keeping its contents.
