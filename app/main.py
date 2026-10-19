"""FastAPI application for the CCS / MS4 price upload tool."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import urllib.parse
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ingest, template_store
from .db import BASE_DIR, get_setting, init_db, session, set_setting
from .generators import ccs as ccs_gen
from .generators import ms4 as ms4_gen
from .generators.common import parse_iso_date

STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="CCS / MS4 Price Upload Tool")


@app.on_event("startup")
def _startup() -> None:
    init_db()
    template_store.seed_templates()


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _bad_request(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail=message)


def file_response(filename: str, content: bytes, media_type: str) -> Response:
    quoted = urllib.parse.quote(filename)
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{filename}"; filename*=UTF-8\'\'{quoted}'
            ),
            "X-Generated-Filename": quoted,
        },
    )


def log_generation(kind: str, filename: str, row_count: int, detail: str = "") -> None:
    with session() as conn:
        conn.execute(
            "INSERT INTO generation_log (created_at, kind, filename, row_count, detail) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                datetime.now().isoformat(timespec="seconds"),
                kind,
                filename,
                row_count,
                detail,
            ),
        )


def current_batch() -> dict | None:
    with session() as conn:
        batch = conn.execute(
            "SELECT * FROM upload_batch ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if batch is None:
            return None
        rows = conn.execute(
            "SELECT id, row_index, hppn, buy_price, sell_price, esc, chosen_position "
            "FROM upload_row WHERE batch_id = ? ORDER BY row_index, id",
            (batch["id"],),
        ).fetchall()
    return {"batch": dict(batch), "rows": [dict(r) for r in rows]}


class UnmatchedVendors(Exception):
    def __init__(self, unmatched: list[dict]):
        self.unmatched = unmatched


class AmbiguousVendors(Exception):
    def __init__(self, ambiguous: list[dict]):
        self.ambiguous = ambiguous


class PriceProblems(Exception):
    def __init__(self, problems: list[dict]):
        self.problems = problems


def decorated_rows() -> list[dict]:
    """Stored rows with supplier/vendor columns resolved against the current map."""
    data = current_batch()
    if data is None:
        return []
    resolved, _unmatched, _ambiguous = ingest.resolve_vendors(data["rows"])
    return resolved


def selected_rows(row_ids: list[int]) -> list[dict]:
    """Resolve the selected rows, refusing to continue if anything is unsettled."""
    if not row_ids:
        raise _bad_request("No rows selected.")
    data = current_batch()
    if data is None:
        raise _bad_request("No data loaded. Upload a file first.")

    wanted = set(row_ids)
    raw = [r for r in data["rows"] if r["id"] in wanted]
    if not raw:
        raise _bad_request(
            "The selected rows are no longer available. Re-upload the file."
        )

    # Re-check against the live map: it may have changed since the upload.
    rows, unmatched, ambiguous = ingest.resolve_vendors(raw)
    if ambiguous:
        raise AmbiguousVendors(ambiguous)
    if unmatched:
        raise UnmatchedVendors(unmatched)
    return rows


def require_prices(rows: list[dict], fields: list[str]) -> None:
    problems = ingest.validate_prices(rows, fields)
    if problems:
        raise PriceProblems(problems)


@app.exception_handler(UnmatchedVendors)
def _unmatched_handler(_request, exc: UnmatchedVendors) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={"ok": False, "kind": "unmatched_vendors", "unmatched": exc.unmatched},
    )


@app.exception_handler(AmbiguousVendors)
def _ambiguous_handler(_request, exc: AmbiguousVendors) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={"ok": False, "kind": "ambiguous_vendors", "ambiguous": exc.ambiguous},
    )


@app.exception_handler(PriceProblems)
def _price_handler(_request, exc: PriceProblems) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={"ok": False, "kind": "price_problems", "problems": exc.problems},
    )


# --------------------------------------------------------------------------
# app state
# --------------------------------------------------------------------------


@app.get("/api/state")
def api_state() -> dict:
    data = current_batch()
    return {
        "theme": get_setting("theme", "dark"),
        "batch": data["batch"] if data else None,
        "rows": decorated_rows(),
        "vendor_map_count": len(ingest.load_vendor_map()),
    }


class ThemeBody(BaseModel):
    theme: str


@app.put("/api/settings/theme")
def api_set_theme(body: ThemeBody) -> dict:
    if body.theme not in ("dark", "light"):
        raise _bad_request("Theme must be 'dark' or 'light'.")
    set_setting("theme", body.theme)
    return {"ok": True, "theme": body.theme}


# --------------------------------------------------------------------------
# upload
# --------------------------------------------------------------------------


@app.post("/api/upload")
async def api_upload(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if not data:
        raise _bad_request("The uploaded file is empty.")
    try:
        return ingest.parse_upload(file.filename or "upload.xlsx", data)
    except ValueError as exc:
        raise _bad_request(str(exc)) from exc


class ConfirmBody(BaseModel):
    token: str
    mapping: dict[str, int]
    # part number -> which map position to use, for parts matching several rules
    choices: dict[str, int] = {}


@app.post("/api/upload/confirm")
def api_upload_confirm(body: ConfirmBody) -> dict:
    try:
        pending = ingest.get_pending(body.token)
    except KeyError as exc:
        raise _bad_request(str(exc)) from exc

    try:
        rows = ingest.build_rows(pending, body.mapping)
    except ValueError as exc:
        raise _bad_request(str(exc)) from exc

    resolved, unmatched, ambiguous = ingest.resolve_vendors(rows, body.choices)
    # Nothing is stored until both questions are settled; the token stays alive
    # so the user can answer and post again without re-picking the file.
    if ambiguous:
        return {"ok": False, "kind": "ambiguous_vendors", "ambiguous": ambiguous}
    if unmatched:
        return {"ok": False, "kind": "unmatched_vendors", "unmatched": unmatched}

    with session() as conn:
        conn.execute("DELETE FROM upload_row")
        conn.execute("DELETE FROM upload_batch")
        cur = conn.execute(
            "INSERT INTO upload_batch (filename, sheet_name, uploaded_at, mapping_json) "
            "VALUES (?, ?, ?, ?)",
            (
                pending["filename"],
                pending["sheet_name"],
                datetime.now().isoformat(timespec="seconds"),
                json.dumps(body.mapping),
            ),
        )
        batch_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO upload_row "
            "(batch_id, row_index, hppn, buy_price, sell_price, esc, chosen_position) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    batch_id,
                    r["row_index"],
                    r["hppn"],
                    r["buy_price"],
                    r["sell_price"],
                    r["esc"],
                    body.choices.get(r["hppn"]),
                )
                for r in rows
            ],
        )

    ingest.drop_pending(body.token)
    data = current_batch()
    return {"ok": True, "batch": data["batch"], "rows": decorated_rows()}


class ChoicesBody(BaseModel):
    choices: dict[str, int]


@app.post("/api/rows/choices")
def api_set_choices(body: ChoicesBody) -> dict:
    """Record which map position to use for part numbers that match twice."""
    with session() as conn:
        for hppn, position in body.choices.items():
            conn.execute(
                "UPDATE upload_row SET chosen_position = ? WHERE hppn = ?",
                (position, hppn),
            )
    return {"ok": True, "rows": decorated_rows()}


# --------------------------------------------------------------------------
# HPPN / Vendor map
# --------------------------------------------------------------------------


class VendorEntry(BaseModel):
    alphabet: str
    position: int = Field(ge=1, le=3)
    supplier_name: str = ""
    ms4_vendor_code: str = ""
    vendor_code: str = ""


@app.get("/api/vendor-map")
def api_vendor_map() -> list[dict]:
    return ingest.load_vendor_map()


@app.post("/api/vendor-map")
def api_vendor_map_add(entry: VendorEntry) -> dict:
    letter = entry.alphabet.strip().upper()
    if len(letter) != 1:
        raise _bad_request("HP P/N vendor alphabet must be a single character.")
    try:
        with session() as conn:
            cur = conn.execute(
                "INSERT INTO vendor_map "
                "(alphabet, position, supplier_name, ms4_vendor_code, vendor_code) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    letter,
                    entry.position,
                    entry.supplier_name.strip(),
                    entry.ms4_vendor_code.strip(),
                    entry.vendor_code.strip(),
                ),
            )
    except sqlite3.IntegrityError as exc:
        raise _bad_request(
            f"'{letter}' at position {entry.position} is already in the map."
        ) from exc
    return {"ok": True, "id": cur.lastrowid}


@app.put("/api/vendor-map/{entry_id}")
def api_vendor_map_update(entry_id: int, entry: VendorEntry) -> dict:
    letter = entry.alphabet.strip().upper()
    if len(letter) != 1:
        raise _bad_request("HP P/N vendor alphabet must be a single character.")
    try:
        with session() as conn:
            cur = conn.execute(
                "UPDATE vendor_map SET alphabet = ?, position = ?, supplier_name = ?, "
                "ms4_vendor_code = ?, vendor_code = ? WHERE id = ?",
                (
                    letter,
                    entry.position,
                    entry.supplier_name.strip(),
                    entry.ms4_vendor_code.strip(),
                    entry.vendor_code.strip(),
                    entry_id,
                ),
            )
    except sqlite3.IntegrityError as exc:
        raise _bad_request(
            f"'{letter}' at position {entry.position} is already in the map."
        ) from exc
    if cur.rowcount == 0:
        raise _bad_request("That map entry no longer exists.")
    return {"ok": True}


@app.get("/api/vendor-map/template")
def api_vendor_map_template() -> Response:
    return file_response(
        "HPPN Vendor Map template.xlsx",
        ingest.build_vendor_map_template(),
        XLSX_MEDIA,
    )


async def run_import(
    file: UploadFile,
    mode: str,
    parse,
    table: str,
    key_of,
    existing_keys: set,
    write,
    summary_extra=None,
) -> dict:
    """Shared preview/merge/replace handling for the settings tables.

    mode='preview' only reports what would happen; 'merge' adds and updates;
    'replace' empties the table first. Nothing is written while the file still
    has errors.
    """
    if mode not in ("preview", "merge", "replace"):
        raise _bad_request("mode must be preview, merge or replace.")

    data = await file.read()
    if not data:
        raise _bad_request("The uploaded file is empty.")
    try:
        parsed = parse(data)
    except ValueError as exc:
        raise _bad_request(str(exc)) from exc

    rows = parsed["rows"]
    errors = parsed["errors"]
    keys = {key_of(r) for r in rows}

    summary = {
        "total": len(rows),
        "new": len(keys - existing_keys),
        "updated": len(keys & existing_keys),
        # What a "replace all" would drop: entries the file does not mention.
        "removed": len(existing_keys - keys),
        **(summary_extra(parsed) if summary_extra else {}),
    }

    if mode == "preview":
        return {
            "ok": not errors and bool(rows),
            "rows": rows,
            "errors": errors,
            "summary": summary,
        }

    if errors:
        raise _bad_request("Fix the errors in the file before importing.")
    if not rows:
        raise _bad_request("The file has no usable rows.")

    with session() as conn:
        if mode == "replace":
            conn.execute(f"DELETE FROM {table}")
        write(conn, rows)

    return {"ok": True, "summary": summary}


@app.post("/api/vendor-map/import")
async def api_vendor_map_import(
    file: UploadFile = File(...), mode: str = Form("preview")
) -> dict:
    existing = {
        (e["alphabet"].upper(), e["position"]) for e in ingest.load_vendor_map()
    }

    def write(conn, rows):
        for row in rows:
            conn.execute(
                "INSERT INTO vendor_map "
                "(alphabet, position, supplier_name, ms4_vendor_code, vendor_code) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(alphabet, position) DO UPDATE SET "
                "supplier_name = excluded.supplier_name, "
                "ms4_vendor_code = excluded.ms4_vendor_code, "
                "vendor_code = excluded.vendor_code",
                (
                    row["alphabet"],
                    row["position"],
                    row["supplier_name"],
                    row["ms4_vendor_code"],
                    row["vendor_code"],
                ),
            )

    return await run_import(
        file,
        mode,
        ingest.parse_vendor_map_file,
        "vendor_map",
        lambda r: (r["alphabet"], r["position"]),
        existing,
        write,
        summary_extra=lambda parsed: {
            "incomplete": sum(1 for r in parsed["rows"] if r["incomplete"]),
            "file_positions": parsed["positions"],
            "current_positions": sorted({p for _a, p in existing}),
        },
    )


@app.delete("/api/vendor-map/{entry_id}")
def api_vendor_map_delete(entry_id: int) -> dict:
    with session() as conn:
        conn.execute("DELETE FROM vendor_map WHERE id = ?", (entry_id,))
    return {"ok": True}


# --------------------------------------------------------------------------
# CCS sites
# --------------------------------------------------------------------------


class SiteBody(BaseModel):
    name: str


@app.get("/api/sites")
def api_sites() -> list[dict]:
    with session() as conn:
        rows = conn.execute("SELECT id, name FROM ccs_sites ORDER BY name").fetchall()
    return [dict(r) for r in rows]


@app.get("/api/sites/template")
def api_sites_template() -> Response:
    return file_response(
        "CCS Sites template.xlsx", ingest.build_sites_template(), XLSX_MEDIA
    )


@app.post("/api/sites/import")
async def api_sites_import(
    file: UploadFile = File(...), mode: str = Form("preview")
) -> dict:
    with session() as conn:
        existing = {r["name"].lower() for r in conn.execute("SELECT name FROM ccs_sites")}

    def write(conn, rows):
        for row in rows:
            conn.execute(
                "INSERT INTO ccs_sites (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
                (row["name"],),
            )

    return await run_import(
        file,
        mode,
        ingest.parse_sites_file,
        "ccs_sites",
        lambda r: r["name"].lower(),
        existing,
        write,
    )


@app.post("/api/sites")
def api_site_add(body: SiteBody) -> dict:
    name = body.name.strip()
    if not name:
        raise _bad_request("Site name cannot be empty.")
    try:
        with session() as conn:
            cur = conn.execute("INSERT INTO ccs_sites (name) VALUES (?)", (name,))
    except sqlite3.IntegrityError as exc:
        raise _bad_request(f"Site '{name}' already exists.") from exc
    return {"ok": True, "id": cur.lastrowid}


@app.put("/api/sites/{site_id}")
def api_site_update(site_id: int, body: SiteBody) -> dict:
    name = body.name.strip()
    if not name:
        raise _bad_request("Site name cannot be empty.")
    try:
        with session() as conn:
            cur = conn.execute(
                "UPDATE ccs_sites SET name = ? WHERE id = ?", (name, site_id)
            )
    except sqlite3.IntegrityError as exc:
        raise _bad_request(f"Site '{name}' already exists.") from exc
    if cur.rowcount == 0:
        raise _bad_request("That site no longer exists.")
    return {"ok": True}


@app.delete("/api/sites/{site_id}")
def api_site_delete(site_id: int) -> dict:
    with session() as conn:
        conn.execute("DELETE FROM ccs_sites WHERE id = ?", (site_id,))
    return {"ok": True}


# --------------------------------------------------------------------------
# MS4 plants
# --------------------------------------------------------------------------


class PlantBody(BaseModel):
    plant: str
    purchase_org: str
    region: str = ""


@app.get("/api/plants")
def api_plants() -> list[dict]:
    with session() as conn:
        rows = conn.execute(
            "SELECT id, plant, purchase_org, region FROM ms4_plants ORDER BY plant"
        ).fetchall()
    return [dict(r) for r in rows]


def _clean_plant(body: PlantBody) -> tuple[str, str, str]:
    plant = body.plant.strip()
    org = body.purchase_org.strip()
    if not plant:
        raise _bad_request("Plant cannot be empty.")
    if not org:
        raise _bad_request("Purchase Org cannot be empty.")
    return plant, org, body.region.strip()


@app.get("/api/plants/template")
def api_plants_template() -> Response:
    return file_response(
        "MS4 Plants template.xlsx", ingest.build_plants_template(), XLSX_MEDIA
    )


@app.post("/api/plants/import")
async def api_plants_import(
    file: UploadFile = File(...), mode: str = Form("preview")
) -> dict:
    with session() as conn:
        existing = {
            r["plant"].lower() for r in conn.execute("SELECT plant FROM ms4_plants")
        }

    def write(conn, rows):
        for row in rows:
            conn.execute(
                "INSERT INTO ms4_plants (plant, purchase_org, region) VALUES (?, ?, ?) "
                "ON CONFLICT(plant) DO UPDATE SET "
                "purchase_org = excluded.purchase_org, region = excluded.region",
                (row["plant"], row["purchase_org"], row["region"]),
            )

    return await run_import(
        file,
        mode,
        ingest.parse_plants_file,
        "ms4_plants",
        lambda r: r["plant"].lower(),
        existing,
        write,
    )


@app.post("/api/plants")
def api_plant_add(body: PlantBody) -> dict:
    plant, org, region = _clean_plant(body)
    try:
        with session() as conn:
            cur = conn.execute(
                "INSERT INTO ms4_plants (plant, purchase_org, region) VALUES (?, ?, ?)",
                (plant, org, region),
            )
    except sqlite3.IntegrityError as exc:
        raise _bad_request(
            f"Plant '{plant}' already exists. A plant can only belong to one Purchase Org."
        ) from exc
    return {"ok": True, "id": cur.lastrowid}


@app.put("/api/plants/{plant_id}")
def api_plant_update(plant_id: int, body: PlantBody) -> dict:
    plant, org, region = _clean_plant(body)
    try:
        with session() as conn:
            cur = conn.execute(
                "UPDATE ms4_plants SET plant = ?, purchase_org = ?, region = ? WHERE id = ?",
                (plant, org, region, plant_id),
            )
    except sqlite3.IntegrityError as exc:
        raise _bad_request(
            f"Plant '{plant}' already exists. A plant can only belong to one Purchase Org."
        ) from exc
    if cur.rowcount == 0:
        raise _bad_request("That plant no longer exists.")
    return {"ok": True}


@app.delete("/api/plants/{plant_id}")
def api_plant_delete(plant_id: int) -> dict:
    with session() as conn:
        conn.execute("DELETE FROM ms4_plants WHERE id = ?", (plant_id,))
    return {"ok": True}


# --------------------------------------------------------------------------
# templates
# --------------------------------------------------------------------------


@app.get("/api/templates")
def api_templates(group: str | None = None) -> list[dict]:
    return template_store.list_templates(group)


@app.get("/api/templates/{key}/download")
def api_template_download(key: str) -> Response:
    try:
        filename, content = template_store.get_template(key)
    except (KeyError, FileNotFoundError) as exc:
        raise _bad_request(str(exc)) from exc
    return file_response(filename, content, "application/octet-stream")


@app.post("/api/templates/{key}")
async def api_template_upload(key: str, file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if not data:
        raise _bad_request("The uploaded file is empty.")
    try:
        template_store.save_template(key, file.filename or "", data)
    except (KeyError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc
    return {"ok": True}


@app.post("/api/templates/{key}/reset")
def api_template_reset(key: str) -> dict:
    try:
        template_store.reset_template(key)
    except (KeyError, FileNotFoundError) as exc:
        raise _bad_request(str(exc)) from exc
    return {"ok": True}


# --------------------------------------------------------------------------
# generation
# --------------------------------------------------------------------------

XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class RowSelection(BaseModel):
    row_ids: list[int]


class DatedSelection(RowSelection):
    date: str


class AssignedSelection(RowSelection):
    assignments: dict[str, list[str]] = {}


class DatedAssignedSelection(DatedSelection):
    assignments: dict[str, list[str]] = {}


def _require_assignments(rows: list[dict], assignments: dict[str, list[str]], what: str):
    missing = [r["hppn"] for r in rows if not assignments.get(r["hppn"])]
    if missing:
        unique = sorted(set(missing))
        preview = ", ".join(unique[:5]) + ("..." if len(unique) > 5 else "")
        raise _bad_request(f"No {what} selected for: {preview}")


@app.post("/api/generate/ccs/price-upload")
def api_ccs_price_upload(body: DatedSelection) -> Response:
    rows = selected_rows(body.row_ids)
    require_prices(rows, ["sell_price", "buy_price", "esc"])
    eff = parse_iso_date(body.date)
    filename, content, count = ccs_gen.generate_price_upload(rows, eff)
    log_generation("CCS price upload", filename, count, f"eff {eff.isoformat()}")
    return file_response(filename, content, XLSX_MEDIA)


@app.post("/api/generate/ccs/cnp")
def api_ccs_cnp(body: RowSelection) -> Response:
    rows = selected_rows(body.row_ids)
    filename, content, count = ccs_gen.generate_cnp_to_y(rows)
    log_generation("CNP to Y", filename, count)
    return file_response(filename, content, XLSX_MEDIA)


@app.post("/api/generate/ccs/vendor-activate")
def api_ccs_vendor_activate(body: AssignedSelection) -> Response:
    rows = selected_rows(body.row_ids)
    _require_assignments(rows, body.assignments, "site")
    filename, content, count = ccs_gen.generate_vendor_activate(rows, body.assignments)
    log_generation("Site Extend", filename, count)
    return file_response(filename, content, XLSX_MEDIA)


@app.post("/api/generate/ms4/buy")
def api_ms4_buy(body: DatedAssignedSelection) -> Response:
    rows = selected_rows(body.row_ids)
    require_prices(rows, ["buy_price"])
    _require_assignments(rows, body.assignments, "plant")
    start = parse_iso_date(body.date)
    filename, content, count = ms4_gen.generate_buy_price(rows, start, body.assignments)
    log_generation("MS4 buy price", filename, count, f"start {start.isoformat()}")
    return file_response(filename, content, "text/csv")


@app.post("/api/generate/ms4/sell")
def api_ms4_sell(body: DatedSelection) -> Response:
    rows = selected_rows(body.row_ids)
    require_prices(rows, ["sell_price"])
    start = parse_iso_date(body.date)
    filename, content, count = ms4_gen.generate_sell_price(rows, start)
    log_generation("MS4 sell price", filename, count, f"start {start.isoformat()}")
    return file_response(filename, content, "text/plain")


@app.post("/api/generate/ms4/esc")
def api_ms4_esc(body: DatedSelection) -> Response:
    rows = selected_rows(body.row_ids)
    require_prices(rows, ["esc"])
    start = parse_iso_date(body.date)
    filename, content, count = ms4_gen.generate_esc_price(rows, start)
    log_generation("MS4 ESC price", filename, count, f"start {start.isoformat()}")
    return file_response(filename, content, "text/csv")


@app.post("/api/generate/ms4/all")
def api_ms4_all(body: DatedAssignedSelection) -> Response:
    rows = selected_rows(body.row_ids)
    require_prices(rows, ["buy_price", "sell_price", "esc"])
    _require_assignments(rows, body.assignments, "plant")
    start = parse_iso_date(body.date)
    filename, content, count, contents = ms4_gen.generate_all(
        rows, start, body.assignments
    )
    detail = "; ".join(f"{c['filename']} ({c['row_count']})" for c in contents)
    log_generation("MS4 all", filename, count, detail)
    return file_response(filename, content, "application/zip")


@app.get("/api/logs")
def api_logs(limit: int = 100) -> list[dict]:
    with session() as conn:
        rows = conn.execute(
            "SELECT id, created_at, kind, filename, row_count, detail "
            "FROM generation_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------
# shutdown + static
# --------------------------------------------------------------------------


@app.post("/api/shutdown")
def api_shutdown() -> dict:
    def stop() -> None:
        os._exit(0)

    threading.Timer(0.5, stop).start()
    return {"ok": True}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
