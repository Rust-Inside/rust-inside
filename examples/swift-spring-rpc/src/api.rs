#[rust_inside::server]
pub fn add(a: i32, b: i32) -> i64 {
    i64::from(a) + i64::from(b)
}
