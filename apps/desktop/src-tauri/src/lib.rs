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
        .setup(|app| {
            crate::scan::store::initialize_database(app.handle())
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            activate_license,
            verify_stored_license,
            startup_revalidate_license,
            clear_license,
            get_runtime_status,
            start_chatgpt_login,
            check_chatgpt_status,
            logout_chatgpt,
            save_azure_config,
            clear_azure_config,
            get_byok_metadata,
            get_byok_status,
            start_scan,
            cancel_scan,
            list_scans,
            get_scan_detail,
            get_scan_events,
            export_sarif,
            check_update_eligibility,
            install_update,
            connect_workspace,
            save_sync_api_key,
            has_sync_api_key,
            sync_findings,
            get_sync_state,
            fetch_sync_cursor,
            disconnect_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LyraShield desktop app");
}

#[cfg(test)]
mod tests {
    #[test]
    fn webview_cannot_access_native_sql_plugin() {
        let capabilities = include_str!("../capabilities/default.json");
        let frontend_package = include_str!("../../frontend/package.json");

        assert!(!capabilities.contains("sql:"));
        assert!(!capabilities.contains("updater:"));
        assert!(!frontend_package.contains("@tauri-apps/plugin-sql"));
    }
}
