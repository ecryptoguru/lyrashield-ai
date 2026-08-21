#![allow(dead_code)]

mod api;
mod byok;
#[macro_use]
mod commands;
mod license;
mod machine_id;
mod runtime;
mod scan;
mod sync;
mod updater;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:lyrashield.db", crate::scan::store::migrations())
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            activate_license,
            verify_stored_license,
            startup_revalidate_license,
            get_license_status,
            clear_license,
            get_runtime_status,
            start_chatgpt_login,
            check_chatgpt_status,
            logout_chatgpt,
            save_azure_config,
            load_azure_config,
            clear_azure_config,
            get_byok_metadata,
            get_byok_status,
            start_scan,
            create_scan,
            cancel_scan,
            list_scans,
            get_scan_detail,
            get_scan_events,
            export_sarif,
            check_update_eligibility,
            connect_workspace,
            sync_findings,
            disconnect_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LyraShield desktop app");
}
