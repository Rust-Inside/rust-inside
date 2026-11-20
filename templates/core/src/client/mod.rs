use crate::common::normalize_handle;

pub(crate) fn format_handle(handle: &str) -> String {
    format!("@{}", normalize_handle(handle))
}
