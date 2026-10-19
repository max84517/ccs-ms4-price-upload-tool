"""MS4 output files."""

from __future__ import annotations

import io
import zipfile
from datetime import date

from ..db import session
from ..ingest import parse_price, price_text
from .common import build_delimited, ms4_date, template_header, today_stamp

VALID_END_DATE = "99991231"
INFO_RECORD_CATEGORY = "0"
CONDITION_TYPE = "PB00"
SELL_CONDITION_TYPE = "ZA08"
CURRENCY = "USD"
PRICE_UNIT = "1"

# The ESC file always lands on the same org/plant.
ESC_PURCHASE_ORG = "HCW1"
ESC_PLANT = "WCMP"


def plant_purchase_orgs() -> dict[str, str]:
    with session() as conn:
        rows = conn.execute("SELECT plant, purchase_org FROM ms4_plants").fetchall()
    return {r["plant"]: r["purchase_org"] for r in rows}


def _standard_line(
    hppn: str,
    vendor_number: str,
    purchase_org: str,
    plant: str,
    start: date,
    amount: str,
) -> list[str]:
    """One row of the shared Buy / Standard layout (12 columns)."""
    return [
        hppn,                       # Material Number
        vendor_number,              # Vendor Number
        purchase_org,               # Purchase Organization
        plant,                      # Plant
        INFO_RECORD_CATEGORY,       # Info Record Category
        CONDITION_TYPE,             # Condition type
        ms4_date(start),            # Validity start date
        VALID_END_DATE,             # Validity end date
        amount,                     # Condition amount
        CURRENCY,                   # Currency
        PRICE_UNIT,                 # Price unit
        "",                         # Deletion Indicator
    ]


def generate_buy_price(
    rows: list[dict], start: date, plant_assignments: dict[str, list[str]]
) -> tuple[str, bytes, int]:
    """Buy price: one line per part per assigned plant."""
    header = template_header("ms4_buy", ",")
    orgs = plant_purchase_orgs()

    out: list[list[str]] = []
    for row in rows:
        amount = price_text(parse_price(row["buy_price"]))
        for plant in plant_assignments.get(row["hppn"]) or []:
            out.append(
                _standard_line(
                    row["hppn"],
                    row["ms4_vendor_code"],
                    orgs.get(plant, ""),
                    plant,
                    start,
                    amount,
                )
            )

    filename = f"MS4 buy price upload_{today_stamp()}.csv"
    return filename, build_delimited(header, out, ","), len(out)


def generate_sell_price(rows: list[dict], start: date) -> tuple[str, bytes, int]:
    """Sell price: tab separated, no plant or customer."""
    header = template_header("ms4_sell", "\t")

    out: list[list[str]] = []
    for row in rows:
        out.append(
            [
                SELL_CONDITION_TYPE,                    # Condition Type
                row["hppn"],                            # Material Number
                "",                                     # Plant
                "",                                     # Customer Number
                price_text(parse_price(row["sell_price"])),  # Condition Amount
                CURRENCY,                               # Currency
                PRICE_UNIT,                             # Price Unit
                ms4_date(start),                        # Valid Start Date
                VALID_END_DATE,                         # Valid End Date
                "",                                     # Mark for Del
            ]
        )

    filename = f"MS4 sell price upload_{today_stamp()}.txt"
    return filename, build_delimited(header, out, "\t"), len(out)


def generate_esc_price(rows: list[dict], start: date) -> tuple[str, bytes, int]:
    """ESC price: same layout as buy, but fixed to HCW1 / WCMP."""
    header = template_header("ms4_standard", ",")

    out: list[list[str]] = []
    for row in rows:
        out.append(
            _standard_line(
                row["hppn"],
                row["ms4_vendor_code"],
                ESC_PURCHASE_ORG,
                ESC_PLANT,
                start,
                price_text(parse_price(row["esc"])),
            )
        )

    filename = f"MS4 ESC price upload_{today_stamp()}.csv"
    return filename, build_delimited(header, out, ","), len(out)


def generate_all(
    rows: list[dict], start: date, plant_assignments: dict[str, list[str]]
) -> tuple[str, bytes, int, list[dict]]:
    """Buy + sell + ESC, bundled into one zip."""
    parts = [
        generate_buy_price(rows, start, plant_assignments),
        generate_sell_price(rows, start),
        generate_esc_price(rows, start),
    ]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content, _count in parts:
            zf.writestr(name, content)

    filename = f"MS4 upload_{today_stamp()}.zip"
    contents = [{"filename": n, "row_count": c} for n, _b, c in parts]
    total = sum(c for _n, _b, c in parts)
    return filename, buf.getvalue(), total, contents
