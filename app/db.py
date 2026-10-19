"""SQLite storage for the CCS / MS4 price upload tool."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "app.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS vendor_map (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alphabet        TEXT    NOT NULL COLLATE NOCASE,
    position        INTEGER NOT NULL,
    supplier_name   TEXT    NOT NULL DEFAULT '',
    ms4_vendor_code TEXT    NOT NULL DEFAULT '',
    vendor_code     TEXT    NOT NULL DEFAULT '',
    UNIQUE (alphabet, position)
);

CREATE TABLE IF NOT EXISTS ccs_sites (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS ms4_plants (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plant        TEXT NOT NULL COLLATE NOCASE,
    purchase_org TEXT NOT NULL COLLATE NOCASE,
    region       TEXT NOT NULL DEFAULT '',
    UNIQUE (plant)
);

CREATE TABLE IF NOT EXISTS templates (
    key        TEXT PRIMARY KEY,
    filename   TEXT NOT NULL,
    content    BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    is_custom  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS upload_batch (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    filename     TEXT NOT NULL,
    sheet_name   TEXT NOT NULL DEFAULT '',
    uploaded_at  TEXT NOT NULL,
    mapping_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS upload_row (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id        INTEGER NOT NULL REFERENCES upload_batch(id) ON DELETE CASCADE,
    row_index       INTEGER NOT NULL,
    hppn            TEXT NOT NULL DEFAULT '',
    -- The Supplier as it came from the uploaded file; it wins over the map.
    supplier        TEXT NOT NULL DEFAULT '',
    buy_price       TEXT NOT NULL DEFAULT '',
    sell_price      TEXT NOT NULL DEFAULT '',
    esc             TEXT NOT NULL DEFAULT '',
    -- Which map position to use when this part matches more than one rule.
    chosen_position INTEGER
);

CREATE INDEX IF NOT EXISTS idx_upload_row_batch ON upload_row (batch_id, row_index);

CREATE TABLE IF NOT EXISTS generation_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind       TEXT NOT NULL,
    filename   TEXT NOT NULL,
    row_count  INTEGER NOT NULL DEFAULT 0,
    detail     TEXT NOT NULL DEFAULT ''
);
"""

DEFAULT_SETTINGS = {
    "theme": "dark",
}


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """Bring a database created by an older build up to the current schema."""
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(upload_row)")}
    if columns and "chosen_position" not in columns:
        conn.execute("ALTER TABLE upload_row ADD COLUMN chosen_position INTEGER")
    if columns and "supplier" not in columns:
        conn.execute(
            "ALTER TABLE upload_row ADD COLUMN supplier TEXT NOT NULL DEFAULT ''"
        )

    # The map used to allow one entry per letter; it now allows one entry per
    # letter *and position*, so the old unique index has to be rebuilt.
    for index in conn.execute("PRAGMA index_list(vendor_map)").fetchall():
        if not index["unique"]:
            continue
        cols = [r["name"] for r in conn.execute(f'PRAGMA index_info("{index["name"]}")')]
        if cols != ["alphabet"]:
            continue
        conn.executescript(
            """
            CREATE TABLE vendor_map_new (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                alphabet        TEXT    NOT NULL COLLATE NOCASE,
                position        INTEGER NOT NULL,
                supplier_name   TEXT    NOT NULL DEFAULT '',
                ms4_vendor_code TEXT    NOT NULL DEFAULT '',
                vendor_code     TEXT    NOT NULL DEFAULT '',
                UNIQUE (alphabet, position)
            );
            INSERT INTO vendor_map_new
                (id, alphabet, position, supplier_name, ms4_vendor_code, vendor_code)
                SELECT id, alphabet, position, supplier_name, ms4_vendor_code, vendor_code
                FROM vendor_map;
            DROP TABLE vendor_map;
            ALTER TABLE vendor_map_new RENAME TO vendor_map;
            """
        )
        break


def init_db() -> None:
    with session() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value)
            )


def get_setting(key: str, default: str | None = None) -> str | None:
    with session() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with session() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
