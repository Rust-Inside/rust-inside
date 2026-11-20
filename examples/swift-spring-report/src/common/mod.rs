pub struct RpcContext {
    pub principal: String,
    pub request_id: String,
}

pub enum ReportReason {
    Spam,
    Harassment,
    Other,
}

pub struct ReportReceipt {
    pub report_id: String,
    pub reporter_id: String,
    pub target_id: String,
    pub reason: ReportReason,
}
