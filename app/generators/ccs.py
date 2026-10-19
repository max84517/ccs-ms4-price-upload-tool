"""CCS output files."""

from __future__ import annotations

from datetime import date

from ..ingest import parse_price
from .common import TemplateSheet, ccs_vendor, today_stamp

# (transaction type, cost type, which price field)
CCS_LINE_TYPES = [
    ("NH", "C", "sell_price"),
    ("NB", "C", "buy_price"),
    ("NB", "F", "esc"),
]

PRICE_UPLOAD_COLUMNS = 12
CNP_COLUMNS = 4
VENDOR_ACTIVATE_COLUMNS = 3


def _vendors(row: dict) -> list[str]:
    """Both vendor identifiers for a part, MS4 code first (with its extra zero)."""
    return [ccs_vendor(row["ms4_vendor_code"]), row["vendor_code"].strip()]


def generate_price_upload(rows: list[dict], eff_date: date) -> tuple[str, bytes, int]:
    """CCS price upload: each part becomes 6 lines (2 vendors x 3 price types)."""
    sheet = TemplateSheet("ccs_upload", PRICE_UPLOAD_COLUMNS)

    for row in rows:
        for vendor in _vendors(row):
            for txn_type, cost_type, field in CCS_LINE_TYPES:
                amount = parse_price(row.get(field, ""))
                sheet.append(
                    [
                        "CORP",          # Site
                        row["hppn"],     # Part No.
                        vendor,          # Vendor
                        txn_type,        # Transaction Type
                        cost_type,       # Cost Type
                        float(amount),   # Cost
                        eff_date,        # Eff From Date
                        None,            # Currency
                        None,            # Exch. Rate
                        None,            # Contract No.
                        None,            # Target Quantity
                        None,            # Target Value
                    ]
                )

    filename = f"CCS price upload_{today_stamp()}.xlsx"
    return filename, sheet.to_bytes(), sheet.row_count


def generate_cnp_to_y(rows: list[dict]) -> tuple[str, bytes, int]:
    """CNP to Y: one line per selected part, everything set to Y."""
    sheet = TemplateSheet("ccs_cnp", CNP_COLUMNS)
    for row in rows:
        sheet.append(["CORP", row["hppn"], "Y", "Y"])

    filename = f"CNP to Y_{today_stamp()}.xlsx"
    return filename, sheet.to_bytes(), sheet.row_count


def generate_vendor_activate(
    rows: list[dict], site_assignments: dict[str, list[str]]
) -> tuple[str, bytes, int]:
    """Site Extend / Vendor Activate: 2 lines per part per assigned site."""
    sheet = TemplateSheet("ccs_vendor_activate", VENDOR_ACTIVATE_COLUMNS)

    for row in rows:
        sites = site_assignments.get(row["hppn"]) or []
        for site in sites:
            for vendor in _vendors(row):
                sheet.append([site, row["hppn"], vendor])

    filename = f"Vendor Activate_{today_stamp()}.xlsx"
    return filename, sheet.to_bytes(), sheet.row_count
