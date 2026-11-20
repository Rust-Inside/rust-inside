use crate::api::common::{ReportReason, ReportReceipt, RpcContext};

pub(crate) fn report(
    context: RpcContext,
    target_id: String,
    reason: ReportReason,
) -> ReportReceipt {
    ReportReceipt {
        report_id: context.request_id,
        reporter_id: context.principal,
        target_id,
        reason,
    }
}
