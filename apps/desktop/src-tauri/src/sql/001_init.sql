-- LyraShield Local — SQLite schema v1
-- Stores scan history and findings locally on the user's machine.

CREATE TABLE IF NOT EXISTS scans (
    scan_id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    finding_count INTEGER DEFAULT 0,
    exit_code INTEGER,
    error TEXT
);

CREATE TABLE IF NOT EXISTS scan_events (
    scan_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scan_id, seq),
    FOREIGN KEY (scan_id) REFERENCES scans(scan_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scan_events_scan_seq ON scan_events(scan_id, seq);

CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    file_path TEXT,
    line_number INTEGER,
    status TEXT DEFAULT 'OPEN',
    verified BOOLEAN DEFAULT 0,
    detected_at TEXT NOT NULL,
    FOREIGN KEY (scan_id) REFERENCES scans(scan_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_findings_scan_id ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_scans_started_at ON scans(started_at DESC);

CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    workspace_id TEXT,
    license_key TEXT,
    cursor TEXT,
    connected_at TEXT,
    last_sync_at TEXT
);
