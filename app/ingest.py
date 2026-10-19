"""Reading the uploaded spreadsheet, mapping its columns, and resolving vendors."""

from __future__ import annotations

import io
import re
import uuid
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

import openpyxl

from .db import session

# Logical field -> label shown in the UI.
REQUIRED_FIELDS = [
    ("hppn", "HP P/N"),
    ("buy_price", "Buy Price"),
    ("sell_price", "Sell Price"),
    ("esc", "ESC"),
]
FIELD_LABELS = dict(REQUIRED_FIELDS)

# Normalised header spellings that auto-map to a field without asking the user.
_AUTO_HEADERS = {
    "hppn": {"hppn", "hppartno", "hppartnumber"},
    "buy_price": {"buyprice"},
    "sell_price": {"sellprice"},
    "esc": {"esc"},
}

# Pending parses waiting for the user to confirm their column mapping.
_PENDING: dict[str, dict] = {}
_PENDING_LIMIT = 8


def _normalise(header: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(header or "").lower())


def _cell_text(value: object) -> str:
    """Render a cell the way the user would expect to see it in the table."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return repr(value)
    if isinstance(value, Decimal):
        return format(value.normalize(), "f")
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value).strip()


def parse_upload(filename: str, data: bytes) -> dict:
    """Read the workbook's first sheet and work out which columns we already have."""
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    except Exception as exc:  # noqa: BLE001 - surfaced to the user verbatim
        raise ValueError(
            f"Could not read '{filename}' as an Excel workbook: {exc}"
        ) from exc

    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    sheet_name = ws.title
    wb.close()
    if not rows:
        raise ValueError(f"'{filename}' is empty.")

    header_row = rows[0]
    headers: list[str] = []
    for idx, value in enumerate(header_row):
        text = _cell_text(value)
        headers.append(text if text else f"(column {idx + 1})")

    # Drop trailing unnamed columns so the dropdowns stay clean.
    while headers and headers[-1].startswith("(column "):
        headers.pop()
    if not headers:
        raise ValueError(f"'{filename}' has no header row.")

    body = [list(r[: len(headers)]) for r in rows[1:]]

    mapping: dict[str, int] = {}
    used: set[int] = set()
    for field, _label in REQUIRED_FIELDS:
        wanted = _AUTO_HEADERS[field]
        for idx, header in enumerate(headers):
            if idx in used:
                continue
            if _normalise(header) in wanted:
                mapping[field] = idx
                used.add(idx)
                break

    token = uuid.uuid4().hex
    if len(_PENDING) >= _PENDING_LIMIT:
        _PENDING.pop(next(iter(_PENDING)))
    _PENDING[token] = {
        "filename": filename,
        "sheet_name": sheet_name,
        "headers": headers,
        "rows": body,
    }

    missing = [f for f, _ in REQUIRED_FIELDS if f not in mapping]
    return {
        "token": token,
        "filename": filename,
        "sheet_name": sheet_name,
        "headers": headers,
        "mapping": mapping,
        "missing": [{"field": f, "label": FIELD_LABELS[f]} for f in missing],
        "row_count": len(body),
    }


def get_pending(token: str) -> dict:
    pending = _PENDING.get(token)
    if pending is None:
        raise KeyError("This upload has expired. Please upload the file again.")
    return pending


def drop_pending(token: str) -> None:
    _PENDING.pop(token, None)


def build_rows(pending: dict, mapping: dict[str, int]) -> list[dict]:
    """Turn the raw sheet into our four-field records, skipping blank part numbers."""
    headers = pending["headers"]
    for field, _label in REQUIRED_FIELDS:
        idx = mapping.get(field)
        if idx is None:
            raise ValueError(f"No column chosen for {FIELD_LABELS[field]}.")
        if not 0 <= idx < len(headers):
            raise ValueError(f"Column for {FIELD_LABELS[field]} is out of range.")
    if len({mapping[f] for f, _ in REQUIRED_FIELDS}) != len(REQUIRED_FIELDS):
        raise ValueError("Each column can only be used once.")

    out: list[dict] = []
    for i, raw in enumerate(pending["rows"]):

        def value(field: str, raw=raw) -> str:
            idx = mapping[field]
            return _cell_text(raw[idx]) if idx < len(raw) else ""

        hppn = value("hppn")
        if not hppn:
            continue
        out.append(
            {
                "row_index": i + 2,  # 1-based sheet row; the header is row 1
                "hppn": hppn,
                "buy_price": value("buy_price"),
                "sell_price": value("sell_price"),
                "esc": value("esc"),
            }
        )
    if not out:
        raise ValueError("No rows with a part number were found in the file.")
    return out


# --------------------------------------------------------------------------
# Vendor resolution
# --------------------------------------------------------------------------


def load_vendor_map() -> list[dict]:
    with session() as conn:
        rows = conn.execute(
            "SELECT id, alphabet, position, supplier_name, ms4_vendor_code, vendor_code "
            "FROM vendor_map ORDER BY position, alphabet"
        ).fetchall()
    return [dict(r) for r in rows]


def vendor_suffix(hppn: str) -> str | None:
    """The characters that follow the first '-' in a part number."""
    text = (hppn or "").strip()
    if "-" not in text:
        return None
    return text.split("-", 1)[1]


def _candidate(entry: dict) -> dict:
    """A map entry as offered to the user when a part matches several rules."""
    ms4 = entry["ms4_vendor_code"].strip()
    code = entry["vendor_code"].strip()
    return {
        "position": entry["position"],
        "alphabet": entry["alphabet"].upper(),
        "supplier_name": entry["supplier_name"],
        "ms4_vendor_code": ms4,
        "vendor_code": code,
        "complete": bool(ms4 and code),
    }


def resolve_vendors(
    rows: list[dict], choices: dict[str, int] | None = None
) -> tuple[list[dict], list[dict], list[dict]]:
    """Attach supplier/vendor codes to each row.

    The map may hold entries at different positions, so one part number can
    match more than one rule. Those are returned in `ambiguous` (one entry per
    part number) for the user to decide; a decision is supplied either through
    `choices` or through a row's own `chosen_position`.

    Returns (resolved_rows, unmatched, ambiguous).
    """
    entries = load_vendor_map()
    by_key = {(e["position"], e["alphabet"].upper()): e for e in entries}
    positions = sorted({e["position"] for e in entries})
    choices = choices or {}

    resolved: list[dict] = []
    unmatched: list[dict] = []
    ambiguous: list[dict] = []
    seen_ambiguous: set[str] = set()

    for row in rows:
        hppn = row["hppn"]
        out = dict(row)
        out.update(supplier_name="", ms4_vendor_code="", vendor_code="", matched_position=None)

        if not entries:
            unmatched.append({**out, "reason": "HPPN/Vendor Map is empty."})
            resolved.append(out)
            continue

        suffix = vendor_suffix(hppn)
        if suffix is None:
            unmatched.append({**out, "reason": "No '-' in the part number."})
            resolved.append(out)
            continue

        candidates = []
        tried = []
        for position in positions:
            if len(suffix) < position:
                continue
            letter = suffix[position - 1].upper()
            tried.append(f"'{letter}' at position {position}")
            entry = by_key.get((position, letter))
            if entry is not None:
                candidates.append(entry)

        if not candidates:
            reason = (
                f"Fewer than {positions[0]} characters after '-'."
                if not tried
                else "No map entry for " + " or ".join(tried) + "."
            )
            unmatched.append({**out, "reason": reason})
            resolved.append(out)
            continue

        picked = None
        if len(candidates) == 1:
            picked = candidates[0]
        else:
            wanted = choices.get(hppn, row.get("chosen_position"))
            if wanted is not None:
                picked = next(
                    (c for c in candidates if c["position"] == wanted), None
                )
            if picked is None:
                if hppn not in seen_ambiguous:
                    seen_ambiguous.add(hppn)
                    ambiguous.append(
                        {
                            "row_index": row.get("row_index"),
                            "hppn": hppn,
                            "candidates": [_candidate(c) for c in candidates],
                        }
                    )
                resolved.append(out)
                continue

        out["supplier_name"] = picked["supplier_name"]
        out["ms4_vendor_code"] = picked["ms4_vendor_code"].strip()
        out["vendor_code"] = picked["vendor_code"].strip()
        out["matched_position"] = picked["position"]
        if len(candidates) > 1:
            out["chosen_position"] = picked["position"]

        missing = []
        if not out["ms4_vendor_code"]:
            missing.append("MS4 vendor code")
        if not out["vendor_code"]:
            missing.append("vendor code")
        if missing:
            letter = picked["alphabet"].upper()
            unmatched.append(
                {
                    **out,
                    "reason": f"Map entry '{letter}' at position {picked['position']} "
                    f"has no {' and no '.join(missing)}.",
                }
            )
        resolved.append(out)

    return resolved, unmatched, ambiguous


# --------------------------------------------------------------------------
# Price validation (blocking, per the agreed behaviour)
# --------------------------------------------------------------------------

PRICE_FIELDS = {
    "buy_price": "Buy Price",
    "sell_price": "Sell Price",
    "esc": "ESC",
}


def parse_price(text: str) -> Decimal | None:
    cleaned = (text or "").strip().replace(",", "")
    if cleaned.startswith("$"):
        cleaned = cleaned[1:].strip()
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def validate_prices(rows: list[dict], fields: list[str]) -> list[dict]:
    """Return one problem entry per offending row/field combination."""
    problems: list[dict] = []
    for row in rows:
        for field in fields:
            raw = row.get(field, "")
            if parse_price(raw) is None:
                problems.append(
                    {
                        "row_index": row.get("row_index"),
                        "hppn": row.get("hppn", ""),
                        "field": PRICE_FIELDS[field],
                        "value": raw,
                        "reason": "Empty" if not (raw or "").strip() else "Not a number",
                    }
                )
    return problems


def price_text(value: Decimal) -> str:
    """Plain decimal text for CSV output - no scientific notation, no padding."""
    return format(value.normalize(), "f")


# --------------------------------------------------------------------------
# Settings-table import / export (vendor map, CCS sites, MS4 plants)
# --------------------------------------------------------------------------

# Each column is (logical field, heading, accepted normalised spellings, required).
VENDOR_MAP_COLUMNS = [
    ("alphabet", "HP P/N Vendor alphabet",
     {"hppnvendoralphabet", "vendoralphabet", "alphabet"}, True),
    ("position", "Position (1-3)", {"position13", "position"}, True),
    ("supplier_name", "Supplier name", {"suppliername", "supplier"}, False),
    ("ms4_vendor_code", "MS4 vendor code",
     {"ms4vendorcode", "ms4code", "ms4vendorno"}, True),
    ("vendor_code", "Vendor code", {"vendorcode", "vendorno"}, True),
]

SITE_COLUMNS = [
    ("name", "Site", {"site", "sitename", "ccssite", "sitecode"}, True),
]

PLANT_COLUMNS = [
    ("plant", "Plant", {"plant", "plantcode", "plantno"}, True),
    ("purchase_org", "Purchase Org",
     {"purchaseorg", "purchaseorganization", "purchasingorg", "porg"}, True),
    ("region", "Region", {"region", "country", "area"}, False),
]


def build_import_template(
    sheet_title: str,
    columns: list[tuple],
    widths: list[int],
    notes: list[list[str]],
    validations: list[tuple[int, str]] | None = None,
) -> bytes:
    """A blank workbook with the right headings, plus a Notes sheet."""
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet_title

    for idx, (_field, heading, _aliases, _required) in enumerate(columns, 1):
        cell = ws.cell(row=1, column=idx, value=heading)
        cell.font = Font(bold=True)
        cell.alignment = Alignment(vertical="center")
        ws.column_dimensions[get_column_letter(idx)].width = widths[idx - 1]
    ws.freeze_panes = "A2"

    for column_index, formula in validations or []:
        dv = DataValidation(type="list", formula1=formula, allow_blank=True)
        ws.add_data_validation(dv)
        letter = get_column_letter(column_index)
        dv.add(f"{letter}2:{letter}500")

    sheet = wb.create_sheet("Notes")
    for row in notes:
        sheet.append(row)
    sheet.column_dimensions["A"].width = 24
    sheet.column_dimensions["B"].width = 72
    sheet["A1"].font = Font(bold=True, size=13)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def read_import_rows(columns: list[tuple], data: bytes) -> list[dict]:
    """Read an import workbook into {row, field: text} records.

    Blank rows are skipped. Raises ValueError when a required column is absent.
    """
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Could not read the file as an Excel workbook: {exc}") from exc

    ws = wb[wb.sheetnames[0]]
    sheet = list(ws.iter_rows(values_only=True))
    wb.close()
    if not sheet:
        raise ValueError("The file is empty.")

    headers = [_normalise(h) for h in sheet[0]]
    index: dict[str, int] = {}
    for field, heading, aliases, required in columns:
        for col, header in enumerate(headers):
            if header in aliases:
                index[field] = col
                break
        if required and field not in index:
            raise ValueError(f"The file has no '{heading}' column.")

    out: list[dict] = []
    for offset, raw in enumerate(sheet[1:]):
        record = {"row": offset + 2}
        for field, _heading, _aliases, _required in columns:
            col = index.get(field)
            record[field] = (
                _cell_text(raw[col]).strip()
                if col is not None and col < len(raw)
                else ""
            )
        if any(record[f] for f, *_ in columns):
            out.append(record)
    return out


def _result(rows: list[dict], errors: list[dict], **extra) -> dict:
    return {"rows": rows, "errors": errors, **extra}


def parse_vendor_map_file(data: bytes) -> dict:
    """Read a vendor map workbook and report what is usable and what is not."""
    rows: list[dict] = []
    errors: list[dict] = []
    seen: dict[tuple[str, int], int] = {}
    positions: set[int] = set()

    for record in read_import_rows(VENDOR_MAP_COLUMNS, data):
        problems: list[str] = []
        alphabet = record["alphabet"]
        if len(alphabet) != 1:
            problems.append(
                "Alphabet must be exactly one character" if alphabet
                else "Alphabet is missing"
            )
        try:
            position = int(float(record["position"]))
        except ValueError:
            position = 0
        if position not in (1, 2, 3):
            problems.append(
                f"Position must be 1, 2 or 3 (found '{record['position']}')"
                if record["position"] else "Position is missing"
            )
        else:
            positions.add(position)

        key = alphabet.upper()
        if len(alphabet) == 1 and position in (1, 2, 3):
            if (key, position) in seen:
                problems.append(
                    f"'{key}' at position {position} already appears on row "
                    f"{seen[(key, position)]}"
                )
            else:
                seen[(key, position)] = record["row"]

        if problems:
            errors.append({"row": record["row"], "label": alphabet,
                           "message": "; ".join(problems)})
            continue

        rows.append(
            {
                "row": record["row"],
                "alphabet": key,
                "position": position,
                "supplier_name": record["supplier_name"],
                "ms4_vendor_code": record["ms4_vendor_code"],
                "vendor_code": record["vendor_code"],
                "incomplete": not (record["ms4_vendor_code"] and record["vendor_code"]),
            }
        )

    return _result(rows, errors, positions=sorted(positions))


def parse_sites_file(data: bytes) -> dict:
    rows: list[dict] = []
    errors: list[dict] = []
    seen: dict[str, int] = {}

    for record in read_import_rows(SITE_COLUMNS, data):
        name = record["name"]
        if not name:
            errors.append({"row": record["row"], "label": "",
                           "message": "Site is missing"})
            continue
        if name.lower() in seen:
            errors.append({
                "row": record["row"],
                "label": name,
                "message": f"'{name}' already appears on row {seen[name.lower()]}",
            })
            continue
        seen[name.lower()] = record["row"]
        rows.append({"row": record["row"], "name": name})

    return _result(rows, errors)


def parse_plants_file(data: bytes) -> dict:
    rows: list[dict] = []
    errors: list[dict] = []
    seen: dict[str, int] = {}

    for record in read_import_rows(PLANT_COLUMNS, data):
        plant = record["plant"]
        org = record["purchase_org"]
        problems: list[str] = []
        if not plant:
            problems.append("Plant is missing")
        if not org:
            problems.append("Purchase Org is missing")
        # A plant belongs to exactly one Purchase Org, so the same plant cannot
        # be listed twice even with a different org.
        if plant and plant.lower() in seen:
            problems.append(
                f"'{plant}' already appears on row {seen[plant.lower()]}; a plant "
                "can only belong to one Purchase Org"
            )
        if problems:
            errors.append({"row": record["row"], "label": plant,
                           "message": "; ".join(problems)})
            continue
        seen[plant.lower()] = record["row"]
        rows.append(
            {
                "row": record["row"],
                "plant": plant,
                "purchase_org": org,
                "region": record["region"],
            }
        )

    return _result(rows, errors)


# --------------------------------------------------------------------------
# The three downloadable templates
# --------------------------------------------------------------------------


def build_vendor_map_template() -> bytes:
    return build_import_template(
        "Vendor Map",
        VENDOR_MAP_COLUMNS,
        [24, 15, 26, 20, 18],
        [
            ["How to fill this in"],
            [],
            ["HP P/N Vendor alphabet",
             "One character. Matched against the part number."],
            ["Position (1-3)", "Which of the 3 characters after the '-' to read."],
            ["", "For Q12345-S23, position 1 is 'S', position 2 is '2'."],
            ["", "Rows may use different positions. The same letter may appear"],
            ["", "once per position. When a part number matches rules at more"],
            ["", "than one position, the tool asks which one to use."],
            ["Supplier name", "Optional. Shown in the main table only."],
            ["MS4 vendor code",
             "Used as-is in MS4 files; CCS files add one leading 0."],
            ["Vendor code", "Used exactly as entered."],
            [],
            ["Delete this sheet or leave it - only the first sheet is read."],
        ],
        validations=[(2, '"1,2,3"')],
    )


def build_sites_template() -> bytes:
    return build_import_template(
        "CCS Sites",
        SITE_COLUMNS,
        [20],
        [
            ["How to fill this in"],
            [],
            ["Site", "One site code per row, for example 01AB."],
            ["", "These are the sites offered when assigning Site Extend."],
            ["", "Codes are compared without case, and each may appear once."],
            [],
            ["Delete this sheet or leave it - only the first sheet is read."],
        ],
    )


def build_plants_template() -> bytes:
    return build_import_template(
        "MS4 Plants",
        PLANT_COLUMNS,
        [16, 20, 20],
        [
            ["How to fill this in"],
            [],
            ["Plant", "The plant code, for example US55."],
            ["Purchase Org",
             "The purchase organization that owns the plant, e.g. HDUS."],
            ["", "A plant belongs to exactly one Purchase Org, but a Purchase"],
            ["", "Org may own many plants. Listing a plant twice is an error."],
            ["Region", "Optional free text, for example US or Mexico."],
            [],
            ["Delete this sheet or leave it - only the first sheet is read."],
        ],
    )
