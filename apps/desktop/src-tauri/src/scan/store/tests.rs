#[test]
fn browser_fixtures_match_real_native_wire_and_export_inputs() {
    let wire: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../e2e/browser/desktop-wire.json"
    ))
    .unwrap();
    let summary: super::ScanSummary = serde_json::from_value(wire["summary"].clone()).unwrap();
    assert_eq!(serde_json::to_value(summary).unwrap(), wire["summary"]);
    let detail: super::ScanDetail = serde_json::from_value(wire["detail"].clone()).unwrap();
    assert_eq!(serde_json::to_value(&detail).unwrap(), wire["detail"]);
    for event in wire["events"].as_array().unwrap() {
        let actual: super::ScanEvent = serde_json::from_value(event.clone()).unwrap();
        assert_eq!(serde_json::to_value(actual).unwrap(), *event);
    }
    for result in wire["syncResults"].as_array().unwrap() {
        let actual: crate::sync::SyncResult = serde_json::from_value(result.clone()).unwrap();
        assert_eq!(serde_json::to_value(actual).unwrap(), *result);
    }
    let sarif: serde_json::Value =
        serde_json::from_str(&super::export_sarif(&detail.findings[..1], &detail.scan_id).unwrap())
            .unwrap();
    assert_eq!(sarif["runs"][0]["results"].as_array().unwrap().len(), 1);
    assert_eq!(
        sarif["runs"][0]["results"][0]["locations"][0]["physicalLocation"]["artifactLocation"]
            ["uri"],
        "src/example.ts"
    );
}

#[test]
fn completed_scan_rejects_late_cancel_and_failure_preserves_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = super::open_database(&dir.path().join("terminal.db")).unwrap();
    for id in ["done", "failed"] {
        conn.execute("INSERT INTO scans (scan_id,target,mode,status,started_at) VALUES (?1,'local','standard','running','now')", [id]).unwrap();
    }
    super::persist_terminal_in(
        &mut conn,
        "done",
        &super::ScanEvent::Completed {
            scan_id: "done".into(),
            exit_code: 0,
            finding_count: 0,
        },
        Some(0),
    )
    .unwrap();
    assert!(super::persist_terminal_in(
        &mut conn,
        "done",
        &super::ScanEvent::Cancelled {
            scan_id: "done".into()
        },
        None
    )
    .is_err());
    assert_eq!(
        conn.query_row("SELECT status FROM scans WHERE scan_id='done'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "completed"
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM scan_events WHERE scan_id='done'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    super::persist_terminal_in(
        &mut conn,
        "failed",
        &super::ScanEvent::Failed {
            scan_id: "failed".into(),
            error: "Engine exited with code 7".into(),
        },
        Some(7),
    )
    .unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT exit_code FROM scans WHERE scan_id='failed'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        7
    );
}

#[test]
fn terminal_status_and_replay_commit_together_and_cannot_be_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut conn = super::open_database(&path).unwrap();
    conn.execute("INSERT INTO scans (scan_id,target,mode,status,started_at) VALUES ('s','local','standard','running','now')", []).unwrap();
    conn.execute("INSERT INTO scan_events (scan_id,seq,kind,payload,created_at) VALUES ('s',9,'progress','{}','now')", []).unwrap();
    // An event failure rolls status back as well; no false cancelled receipt.
    conn.execute_batch("CREATE TRIGGER fail_terminal BEFORE INSERT ON scan_events BEGIN SELECT RAISE(ABORT, 'disk write failed'); END;").unwrap();
    let cancelled = super::ScanEvent::Cancelled {
        scan_id: "s".into(),
    };
    assert!(super::persist_terminal_in(&mut conn, "s", &cancelled, None).is_err());
    assert_eq!(
        conn.query_row("SELECT status FROM scans WHERE scan_id='s'", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "running"
    );
    conn.execute_batch("DROP TRIGGER fail_terminal").unwrap();
    super::persist_terminal_in(&mut conn, "s", &cancelled, None).unwrap();
    let completed = super::ScanEvent::Completed {
        scan_id: "s".into(),
        exit_code: 0,
        finding_count: 0,
    };
    assert!(super::persist_terminal_in(&mut conn, "s", &completed, None).is_err());
    assert!(super::persist_terminal_in(&mut conn, "s", &cancelled, None).is_err());
    drop(conn);
    let conn = super::connect_database(&path).unwrap();
    let (status, kind, seq): (String, String, i64) = conn
        .query_row(
            "SELECT status,kind,seq FROM scans JOIN scan_events USING(scan_id) WHERE seq=10",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (status.as_str(), kind.as_str(), seq),
        ("cancelled", "cancelled", 10)
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM scan_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

use super::*;
#[test]
fn normal_reads_do_not_acquire_migration_write_locks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lyrashield.db");
    assert!(connect_database(&path).is_err());
    assert!(!path.exists());
    let writer = open_database(&path).unwrap();
    let mode: String = writer
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let reader = connect_database(&path).unwrap();
    reader.busy_timeout(std::time::Duration::ZERO).unwrap();
    let count: i64 = reader
        .query_row("SELECT COUNT(*) FROM _sqlx_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, super::MIGRATIONS.len() as i64);
    writer.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn opens_an_existing_sqlx_database_without_rewriting_its_receipt() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("lyrashield.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(include_str!("../../sql/001_init.sql"))
        .unwrap();
    conn.execute_batch(MIGRATION_TABLE).unwrap();
    // SHA-384 of the shipped v1 SQL, matching SQLx Migration::new.
    conn.execute("INSERT INTO _sqlx_migrations (version,description,success,checksum,execution_time) VALUES (1,'create scans and findings tables',1,x'3a07a2a94f5c125f3e6e67331ceb6b900897c7c1c7bf58a505e202c4e14844d440e510be74038e6df9273660cd18d4c8',42)", []).unwrap();
    conn.execute("INSERT INTO scans (scan_id,target,mode,status,started_at) VALUES ('legacy','local','standard','completed','before-upgrade')", []).unwrap();
    drop(conn);
    let conn = open_database(&path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT started_at FROM scans WHERE scan_id='legacy'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "before-upgrade"
    );
    assert_eq!(
        conn.query_row(
            "SELECT execution_time FROM _sqlx_migrations WHERE version=1",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        42
    );
}

#[test]
fn disk_database_preserves_sqlx_migrations_and_existing_history() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("config/lyrashield.db");
    // First startup creates the directory, schema and SQLx-compatible version receipt.
    let conn = open_database(&path).unwrap();
    let checksum: Vec<u8> = conn
        .query_row(
            "SELECT checksum FROM _sqlx_migrations WHERE version = 1 AND success = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        checksum,
        Sha384::digest(MIGRATIONS[0].2.as_bytes()).to_vec()
    );
    conn.execute("INSERT INTO scans (scan_id,target,mode,status,started_at) VALUES ('existing','local','standard','completed','now')", []).unwrap();
    conn.execute(
        "UPDATE scans SET threat_model_available=1 WHERE scan_id='existing'",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO findings (id,scan_id,severity,title,detected_at,evidence_context) VALUES ('context-1','existing','HIGH','Context','now',?)",
        [r#"{"contextual_cvss_reasoning":"Remote reach","advisory_cvss":{"score":8.6},"evidence_warnings":["No admin session"],"update_history":[{"fields":["severity"]}]}"#],
    ).unwrap();
    drop(conn);
    // Existing data and version bookkeeping survive repeat startup.
    for _ in 0..2 {
        let conn = open_database(&path).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM scans WHERE scan_id='existing'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM _sqlx_migrations", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            super::MIGRATIONS.len() as i64
        );
        let (threat, context): (i64, String) = conn
            .query_row(
                "SELECT s.threat_model_available, f.evidence_context FROM scans s JOIN findings f ON f.scan_id=s.scan_id WHERE f.id='context-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(threat, 1);
        let parsed: super::FindingEvidenceContext = serde_json::from_str(&context).unwrap();
        assert_eq!(parsed.advisory_cvss.unwrap()["score"], 8.6);
    }
    let mut conn = open_database(&path).unwrap();
    let broken = [
        MIGRATIONS[0],
        (
            2,
            "broken",
            "CREATE TABLE should_rollback (id INTEGER); INVALID SQL;",
        ),
    ];
    assert!(migrate_database(&mut conn, &broken).is_err());
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='should_rollback'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM _sqlx_migrations", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        MIGRATIONS.len() as i64
    );
    drop(conn);
    let mut conn = open_database(&path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM scans WHERE scan_id='existing'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    let next = [
        MIGRATIONS[0],
        MIGRATIONS[1],
        MIGRATIONS[2],
        (4, "next", "CREATE TABLE next_version (id INTEGER);"),
    ];
    migrate_database(&mut conn, &next).unwrap();
    migrate_database(&mut conn, &next).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM _sqlx_migrations", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
}

#[test]
fn existing_sqlx_ledger_rejects_tampering_dirty_and_unknown_versions() {
    for alteration in [
        "UPDATE _sqlx_migrations SET checksum=x'00'",
        "UPDATE _sqlx_migrations SET success=0",
        "UPDATE _sqlx_migrations SET version=99 WHERE version=2",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("lyrashield.db");
        let conn = open_database(&path).unwrap();
        conn.execute(alteration, []).unwrap();
        drop(conn);
        assert!(open_database(&path).is_err());
    }
    let tmp = tempfile::tempdir().unwrap();
    let invalid_path = tmp.path().join("directory.db");
    std::fs::create_dir(&invalid_path).unwrap();
    assert!(open_database(&invalid_path).is_err());
}
#[tokio::test]
async fn sequenced_events_roundtrip() {
    let store = TestStorage::new_in_memory();
    let scan_id = "scan-test-123";
    store
        .execute(
            "INSERT INTO scans (scan_id, target, mode, status, started_at) VALUES (?, ?, ?, ?, ?)",
            vec![
                scan_id.into(),
                "local".into(),
                "\"standard\"".into(),
                "pending".into(),
                "now".into(),
            ],
        )
        .await
        .unwrap();
    let ev = ScanEvent::Started {
        scan_id: scan_id.into(),
    };
    let payload = serde_json::to_string(&ev).unwrap();
    store
        .execute(
            "INSERT INTO scan_events (scan_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            vec![scan_id.into(), 0.into(), "started".into(), payload.into(), "now".into()],
        )
        .await
        .unwrap();
    let rows = store
        .select(
            "SELECT seq, payload FROM scan_events WHERE scan_id = ? ORDER BY seq",
            vec![scan_id.into()],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get("seq").unwrap().as_i64().unwrap(), 0);
}
#[tokio::test]
async fn secret_not_in_event_payload() {
    let ev = ScanEvent::Progress {
        scan_id: "s1".into(),
        line: "hello".into(),
        stream: "stdout".into(),
    };
    let s = serde_json::to_string(&ev).unwrap();
    assert!(!s.contains("sk-"), "event should not contain secret");
}

#[test]
fn v1_database_migrates_and_old_rows_stay_readable() {
    // Simulate a shipped v1 database: apply only the initial schema through
    // the same ledger, then run the full migration set. Old rows keep
    // readable defaults — workflow REVIEW_TARGET (pre-workflow scans were
    // snapshot reviews), verification DETECTED, evidence fields NULL
    // (unknown, never guessed).
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    super::migrate_database(&mut conn, &super::MIGRATIONS[..1]).unwrap();
    conn.execute(
        "INSERT INTO scans (scan_id, target, mode, status, started_at, finding_count) VALUES ('s1','/repo','\"standard\"','completed','now',1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO findings (id, scan_id, severity, title, status, verified, detected_at) VALUES ('f1','s1','HIGH','t','OPEN',1,'2026-09-19')",
        [],
    )
    .unwrap();
    super::migrate_database(&mut conn, super::MIGRATIONS).unwrap();

    let (workflow, backend, contract): (String, String, Option<String>) = conn
        .query_row(
            "SELECT workflow, backend, contract_version FROM scans WHERE scan_id='s1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(workflow, "REVIEW_TARGET");
    assert_eq!(backend, "local");
    assert!(contract.is_none(), "unknown contract stays NULL");

    let (vstate, pending, counter): (String, i64, Option<String>) = conn
        .query_row(
            "SELECT verification_state, evidence_pending, counterevidence FROM findings WHERE id='f1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(vstate, "DETECTED");
    assert_eq!(pending, 0);
    assert!(counter.is_none());

    let (context, threat_available): (Option<String>, Option<i64>) = conn
        .query_row(
            "SELECT f.evidence_context, s.threat_model_available FROM findings f JOIN scans s ON s.scan_id=f.scan_id WHERE f.id='f1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(context.is_none(), "old evidence remains not-recorded");
    assert!(
        threat_available.is_none(),
        "old threat state remains unknown"
    );

    // And the new write path accepts the extended fields.
    conn.execute(
        "INSERT INTO findings (id, scan_id, severity, title, status, verified, detected_at, verification_state, evidence_pending, counterevidence, http_exchange_ids) VALUES ('f2','s1','HIGH','t2','OPEN',0,'2026-09-20','DETECTED',1,'ce','[\"ex-1\"]')",
        [],
    )
    .unwrap();
    let pending2: i64 = conn
        .query_row(
            "SELECT evidence_pending FROM findings WHERE id='f2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending2, 1);
}
