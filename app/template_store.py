"""Template files (CCS xlsx / MS4 csv+txt) kept as blobs in SQLite.

The repo copy under templates_seed/ is only used to fill an empty database and
to support "Reset to default"; everything the generators read comes from the DB,
so replacing a template in Settings takes effect permanently.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from .db import BASE_DIR, session

SEED_DIR = BASE_DIR / "templates_seed"

TEMPLATES = [
    {
        "key": "ccs_upload",
        "group": "CCS",
        "label": "CCS upload template",
        "filename": "CCS upload template.xlsx",
        "seed": SEED_DIR / "CCS" / "CCS upload template.xlsx",
        "extensions": [".xlsx"],
    },
    {
        "key": "ccs_cnp",
        "group": "CCS",
        "label": "CNP to Y",
        "filename": "CNP to Y.xlsx",
        "seed": SEED_DIR / "CCS" / "CNP to Y.xlsx",
        "extensions": [".xlsx"],
    },
    {
        "key": "ccs_vendor_activate",
        "group": "CCS",
        "label": "Vendor Activate",
        "filename": "Vendor Activate.xlsx",
        "seed": SEED_DIR / "CCS" / "Vendor Activate.xlsx",
        "extensions": [".xlsx"],
    },
    {
        "key": "ms4_buy",
        "group": "MS4",
        "label": "Buy Template",
        "filename": "Buy Template.csv",
        "seed": SEED_DIR / "MS4" / "Buy Template.csv",
        "extensions": [".csv"],
    },
    {
        "key": "ms4_sell",
        "group": "MS4",
        "label": "Sell Template",
        "filename": "Sell Template.txt",
        "seed": SEED_DIR / "MS4" / "Sell Template.txt",
        "extensions": [".txt"],
    },
    {
        "key": "ms4_standard",
        "group": "MS4",
        "label": "Standard Template",
        "filename": "Standard Template.csv",
        "seed": SEED_DIR / "MS4" / "Standard Template.csv",
        "extensions": [".csv"],
    },
]

BY_KEY = {t["key"]: t for t in TEMPLATES}


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def seed_templates() -> None:
    """Load any template that is not in the DB yet from templates_seed/."""
    with session() as conn:
        for meta in TEMPLATES:
            row = conn.execute(
                "SELECT key FROM templates WHERE key = ?", (meta["key"],)
            ).fetchone()
            if row:
                continue
            seed: Path = meta["seed"]
            if not seed.exists():
                continue
            conn.execute(
                "INSERT INTO templates (key, filename, content, updated_at, is_custom) "
                "VALUES (?, ?, ?, ?, 0)",
                (meta["key"], meta["filename"], seed.read_bytes(), _now()),
            )


def list_templates(group: str | None = None) -> list[dict]:
    with session() as conn:
        rows = {
            r["key"]: r
            for r in conn.execute(
                "SELECT key, filename, updated_at, is_custom, length(content) AS size "
                "FROM templates"
            )
        }
    out = []
    for meta in TEMPLATES:
        if group and meta["group"] != group:
            continue
        row = rows.get(meta["key"])
        out.append(
            {
                "key": meta["key"],
                "group": meta["group"],
                "label": meta["label"],
                "default_filename": meta["filename"],
                "filename": row["filename"] if row else meta["filename"],
                "updated_at": row["updated_at"] if row else None,
                "is_custom": bool(row["is_custom"]) if row else False,
                "size": row["size"] if row else 0,
                "present": row is not None,
                "extensions": meta["extensions"],
            }
        )
    return out


def get_template(key: str) -> tuple[str, bytes]:
    """Return (filename, content) for a template key, raising if absent."""
    if key not in BY_KEY:
        raise KeyError(f"Unknown template key: {key}")
    with session() as conn:
        row = conn.execute(
            "SELECT filename, content FROM templates WHERE key = ?", (key,)
        ).fetchone()
    if row is None:
        raise FileNotFoundError(
            f"Template '{BY_KEY[key]['label']}' is missing. "
            "Upload it in Settings before generating."
        )
    return row["filename"], row["content"]


def get_template_bytes(key: str) -> bytes:
    return get_template(key)[1]


def save_template(key: str, filename: str, content: bytes) -> None:
    if key not in BY_KEY:
        raise KeyError(f"Unknown template key: {key}")
    allowed = BY_KEY[key]["extensions"]
    if Path(filename).suffix.lower() not in allowed:
        raise ValueError(
            f"{BY_KEY[key]['label']} must be a {' or '.join(allowed)} file."
        )
    with session() as conn:
        conn.execute(
            "INSERT INTO templates (key, filename, content, updated_at, is_custom) "
            "VALUES (?, ?, ?, ?, 1) "
            "ON CONFLICT(key) DO UPDATE SET filename = excluded.filename, "
            "content = excluded.content, updated_at = excluded.updated_at, is_custom = 1",
            (key, filename, content, _now()),
        )


def reset_template(key: str) -> None:
    """Restore the shipped default for one template."""
    meta = BY_KEY[key]
    seed: Path = meta["seed"]
    if not seed.exists():
        raise FileNotFoundError(f"No bundled default for {meta['label']}.")
    with session() as conn:
        conn.execute(
            "INSERT INTO templates (key, filename, content, updated_at, is_custom) "
            "VALUES (?, ?, ?, ?, 0) "
            "ON CONFLICT(key) DO UPDATE SET filename = excluded.filename, "
            "content = excluded.content, updated_at = excluded.updated_at, is_custom = 0",
            (meta["key"], meta["filename"], seed.read_bytes(), _now()),
        )
