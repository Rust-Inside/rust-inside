pub(crate) fn normalize_handle(handle: &str) -> String {
    handle.trim().trim_start_matches('@').to_lowercase()
}
