pub fn format_handle(handle: String) -> String {
    crate::client::format_handle(&handle)
}

pub fn same_handle(left: String, right: String) -> bool {
    crate::server::same_handle(&left, &right)
}
