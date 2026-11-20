import CalculatorSDK
import Foundation

guard CommandLine.arguments.count == 2, let baseURL = URL(string: CommandLine.arguments[1]) else {
    fatalError("Pass the Spring server URL")
}

let calculator = RpcClient(baseURL: baseURL)
let result = try await calculator.add(2, 3)
print(result)
