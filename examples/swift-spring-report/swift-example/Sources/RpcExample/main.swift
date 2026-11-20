import Foundation
import ReportsSDK

guard CommandLine.arguments.count == 2,
      let baseURL = URL(string: CommandLine.arguments[1]),
      let password = ProcessInfo.processInfo.environment["REPORT_DEMO_PASSWORD"] else {
    fatalError("Pass the local Spring server URL and set REPORT_DEMO_PASSWORD")
}

let credential = Data("martin:\(password)".utf8).base64EncodedString()
let client = RpcClient(baseURL: baseURL, authorization: "Basic \(credential)")
let receipt = try await client.report("post-42", .spam)
print(receipt.reportId)
