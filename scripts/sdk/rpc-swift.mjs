import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const swiftTypes = new Map([
  ['String', 'String'],
  ['i32', 'Int32'],
  ['i64', 'Int64'],
]);
const swiftType = type => swiftTypes.get(type) ?? `\`${type}\``;
const camelCase = name => name.replace(/_([a-z0-9])/g, (_, next) => next.toUpperCase());

function wireVariant(name) {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function swiftEnum({ name, variants }) {
  const cases = variants.map(variant => {
    const wire = wireVariant(variant);
    return `    case \`${camelCase(wire.toLowerCase())}\` = ${JSON.stringify(wire)}`;
  });
  return `public enum \`${name}\`: String, Codable, Sendable {
${cases.join('\n')}
}`;
}

function codingKeys(fields, indent) {
  const cases = fields.map(({ name, wire }) => `${indent}    case \`${name}\` = ${JSON.stringify(wire)}`);
  return `${indent}private enum CodingKeys: String, CodingKey {
${cases.join('\n')}
${indent}}`;
}

function swiftRecord({ name, fields }) {
  const properties = fields.map(field => ({ ...field, wire: field.name, name: camelCase(field.name) }));
  const declarations = properties.map(field => `    public let \`${field.name}\`: ${swiftType(field.type)}`);
  const parameters = properties.map(field => `\`${field.name}\`: ${swiftType(field.type)}`).join(', ');
  const assignments = properties.map(field => `        self.\`${field.name}\` = \`${field.name}\``);
  const initializer = `    public init(${parameters}) {
${assignments.join('\n')}
    }`;
  const members = [declarations.join('\n'), initializer, properties.length && codingKeys(properties, '    ')].filter(Boolean);
  return `public struct \`${name}\`: Codable, Sendable {
${members.join('\n\n')}
}`;
}

function swiftMethod(operation, index) {
  const args = Object.entries(operation.args)
    .filter(([, type]) => type !== 'RpcContext')
    .map(([wire, type], index) => ({ name: `argument${index + 1}`, wire, type }));
  const parameters = args.map(field => `_ ${field.name}: ${swiftType(field.type)}`).join(', ');
  const fields = args.map(field => `${field.name}: ${field.name}`).join(', ');
  const type = `_CallArguments${index}`;
  const body = fields ? `${type}(${fields})` : '[String: Int32]()';
  const method = `    public func \`${operation.jsName}\`(${parameters}) async throws -> ${swiftType(operation.returns)} {
        try await call(operation: ${JSON.stringify(operation.jsName)}, arguments: ${body})
    }`;
  if (!args.length) return method;
  const stored = args.map(field => `        let ${field.name}: ${swiftType(field.type)}`).join('\n');
  return `${method}

    private struct ${type}: Encodable {
${stored}

${codingKeys(args, '        ')}
    }`;
}

export async function writeSwiftRpcPackage(directory, sdk) {
  const source = join(directory, 'Sources', sdk.module);
  const types = [
    ...(sdk.enums ?? []).map(swiftEnum),
    ...(sdk.records ?? []).filter(record => record.name !== 'RpcContext').map(swiftRecord),
  ];
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
    private let _authorization: String?

    public init(baseURL: URL, authorization: String? = nil) {
        self._baseURL = baseURL
        self._authorization = authorization
    }

${sdk.exports.map(swiftMethod).join('\n\n')}

    private func call<Arguments: Encodable, Value: Decodable>(operation: String, arguments: Arguments) async throws -> Value {
        let url = _baseURL.appendingPathComponent("rpc").appendingPathComponent(operation)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authorization = _authorization {
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
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
  if (types.length) await writeFile(join(source, 'RpcTypes.swift'), types.join('\n\n') + '\n');
}
