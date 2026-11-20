import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const swiftInteger = { i32: 'Int32', i64: 'Int64' };

function swiftMethod(operation) {
  const args = Object.entries(operation.args);
  const parameters = args.map(([, type], index) => `_ argument${index + 1}: ${swiftInteger[type]}`).join(', ');
  const fields = args.map(([name], index) => `${JSON.stringify(name)}: Int64(argument${index + 1})`).join(', ');
  const body = fields ? `[${fields}]` : '[:]';
  return `    public func \`${operation.jsName}\`(${parameters}) async throws -> ${swiftInteger[operation.returns]} {
        try await call(operation: ${JSON.stringify(operation.jsName)}, arguments: ${body})
    }`;
}

export async function writeSwiftRpcPackage(directory, sdk) {
  const source = join(directory, 'Sources', sdk.module);
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'Package.swift'), `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "${sdk.module}",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [.library(name: "${sdk.module}", targets: ["${sdk.module}"])],
    targets: [.target(name: "${sdk.module}")]
)
`),
    writeFile(join(source, 'RpcClient.swift'), `import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum RpcError: LocalizedError {
    case invalidResponse
    case httpStatus(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse: "The RPC server did not send an HTTP response."
        case .httpStatus(let code): "The RPC server returned HTTP \\(code)."
        }
    }
}

public struct RpcClient: Sendable {
    private let _baseURL: URL

    public init(baseURL: URL) {
        self._baseURL = baseURL
    }

${sdk.exports.map(swiftMethod).join('\n\n')}

    private func call<Value: Decodable>(operation: String, arguments: [String: Int64]) async throws -> Value {
        let url = _baseURL.appendingPathComponent("rpc").appendingPathComponent(operation)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(arguments)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw RpcError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            throw RpcError.httpStatus(response.statusCode)
        }
        return try JSONDecoder().decode(Value.self, from: data)
    }
}
`),
  ]);
}
