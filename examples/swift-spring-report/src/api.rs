#[path = "common/mod.rs"]
pub mod common;

use common::{ReportReason, ReportReceipt, RpcContext};

#[rust_inside::server]
pub fn report(context: RpcContext, target_id: String, reason: ReportReason) -> ReportReceipt {
    crate::server::report(context, target_id, reason)
}
