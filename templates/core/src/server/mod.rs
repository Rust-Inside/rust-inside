use crate::common::normalize_handle;

pub(crate) fn same_handle(left: &str, right: &str) -> bool {
    normalize_handle(left) == normalize_handle(right)
}
