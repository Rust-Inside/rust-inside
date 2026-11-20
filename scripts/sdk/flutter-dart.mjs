const camel = name => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const dartTypes = {
  bool: 'bool', String: 'String', f32: 'double', f64: 'double', u64: 'BigInt',
  'Vec<String>': 'List<String>', 'Vec<u8>': 'List<int>', 'Vec<u32>': 'List<int>', '()': 'void',
};
const dartType = type => dartTypes[type] ?? 'int';

function encode(type, name) {
  return ['f32', 'f64', 'u64'].includes(type) ? `${name}.toString()` : name;
}

function decode(type, value) {
  if (type === '()') return value;
  if (type === 'u64') return `BigInt.parse(${value} as String)`;
  if (type === 'f32' || type === 'f64') return `_double(${value} as String)`;
  if (type.startsWith('Vec<')) return `${dartType(type)}.from(${value} as List)`;
  return `${value} as ${dartType(type)}`;
}

function parameters(args, named = false) {
  const params = Object.entries(args).map(([name, type]) => `${named ? 'required ' : ''}${dartType(type)} ${camel(name)}`);
  return named && params.length ? '{' + params.join(', ') + '}' : params.join(', ');
}

function values(args) {
  return Object.entries(args).map(([name, type]) => encode(type, camel(name))).join(', ');
}

const keywords = new Set(('assert break case catch class const continue default do else enum extends false final finally for if in is new null rethrow return super switch this throw true try var void while with await yield').split(' '));
const objectMembers = new Set(['runtimeType', 'hashCode', 'toString', 'noSuchMethod', 'close']);
const reservedTypes = new Set(['String', 'BigInt', 'Object', 'List', 'Map', 'Future', 'Finalizer', 'StateError', 'Exception']);
const reservedFunctions = new Set(['int', 'double', 'bool', 'num', 'dynamic', 'convert', 'ffi', 'mem', 'isolate']);

export function flutterDartSource(sdk) {
  const { exports, clients = [], records = [], flutterLibrary: library, flutterPackage: pkg } = sdk;
  const forbidden = (name, set) => {
    if (keywords.has(name) || set?.has(name)) throw new Error(`Choose a portable Flutter SDK identifier instead of ${name}`);
  };
  for (const fn of exports) {
    forbidden(fn.jsName, reservedFunctions);
    for (const name of Object.keys(fn.args)) forbidden(camel(name));
  }
  for (const record of records) {
    forbidden(record.name, reservedTypes);
    for (const f of record.fields) forbidden(camel(f.name), objectMembers);
  }
  for (const c of clients) {
    forbidden(c.name, reservedTypes);
    for (const name of Object.keys(c.constructor.args)) forbidden(camel(name));
    for (const m of c.methods) {
      forbidden(m.jsName, objectMembers);
      for (const name of Object.keys(m.args)) forbidden(camel(name));
    }
  }

  const contents = [`import 'dart:convert' as convert;
import 'dart:ffi' as ffi;${clients.length ? "\nimport 'dart:isolate' as isolate;" : ''}
import 'package:ffi/ffi.dart' as mem;

@ffi.Native<ffi.Pointer<mem.Utf8> Function(ffi.Pointer<mem.Utf8>)>(
  symbol: '${library}_call', assetId: 'package:${pkg}/${pkg}.dart',
)
external ffi.Pointer<mem.Utf8> _nativeCall(ffi.Pointer<mem.Utf8> request);

@ffi.Native<ffi.Void Function(ffi.Pointer<mem.Utf8>)>(
  symbol: '${library}_free', assetId: 'package:${pkg}/${pkg}.dart',
)
external void _nativeFree(ffi.Pointer<mem.Utf8> response);

Object? _call(String method, List<Object?> args) {
  final message = convert.jsonEncode([method, ...args]);
  final request = mem.StringUtf8Pointer(message).toNativeUtf8(allocator: mem.calloc);
  try {
    final response = _nativeCall(request);
    try {
      final data = convert.jsonDecode(mem.Utf8Pointer(response).toDartString()) as Map;
      if (data.containsKey('error')) throw StateError(data['error'] as String);
      return data['value'];
    } finally {
      _nativeFree(response);
    }
  } finally {
    mem.calloc.free(request);
  }
}`];
  if (exports.some(f => ['f32', 'f64'].includes(f.returns)) ||
      records.some(r => r.fields.some(f => ['f32', 'f64'].includes(f.type)))) {
    contents.push(`double _double(String text) => switch (text) {
  'inf' => double.infinity,
  '-inf' => double.negativeInfinity,
  _ => double.parse(text),
};`);
  }
  if (clients.length) {
    contents.push(`// Send only the method name and wire values to the worker isolate.
Future<Object?> _worker(String method, List<Object?> args) =>
    isolate.Isolate.run(() => _call(method, args));

abstract base class _Client {
  static final _finalizer = Finalizer<int>((id) => _call('_close', [id]));
  final int _id;
  int _pending = 0;
  bool _closed = false;

  _Client(this._id) { _finalizer.attach(this, _id, detach: this); }

  Future<Object?> _invoke(String method, List<Object?> args) async {
    if (_closed) throw StateError('SDK client is closed');
    _pending++;
    try {
      return await _worker(method, [_id, ...args]);
    } finally {
      _pending--;
      if (_closed && _pending == 0) _release();
    }
  }

  void _release() {
    _finalizer.detach(this);
    _call('_close', [_id]);
  }

  /// Release native state after any calls already in progress have finished.
  void close() {
    if (_closed) return;
    _closed = true;
    if (_pending == 0) _release();
  }
}`);
  }
  for (const record of records) {
    const fields = record.fields.map(f => `  final ${dartType(f.type)} ${camel(f.name)};`);
    const methodsUseRecord = clients.some(c => c.methods.some(m => m.returns === record.name));
    const constructor = record.fields.map(f => `required this.${camel(f.name)}`).join(', ');
    const factory = methodsUseRecord
      ? `\n  factory ${record.name}._from(Map data) => ${record.name}(\n` +
        record.fields.map(f => `    ${camel(f.name)}: ${decode(f.type, `data['${camel(f.name)}']`)},`).join('\n') + '\n  );'
      : '';
    contents.push(`final class ${record.name} {
${fields.join('\n')}
  const ${record.name}(${constructor ? '{' + constructor + '}' : ''});${factory}
}`);
  }
  for (const fn of exports) {
    const call = `_call('${fn.name}', [${values(fn.args)}])`;
    contents.push(fn.returns === '()'
      ? `void ${fn.jsName}(${parameters(fn.args)}) { ${call}; }`
      : `${dartType(fn.returns)} ${fn.jsName}(${parameters(fn.args)}) => ${decode(fn.returns, call)};`);
  }
  for (const c of clients) {
    const methods = c.methods.map(m => `  Future<${m.returns}> ${m.jsName}(${parameters(m.args)}) async =>
      ${m.returns}._from(await _invoke('${c.name}.${m.name}', [${values(m.args)}]) as Map);`);
    contents.push(`final class ${c.name} extends _Client {
  ${c.name}(${parameters(c.constructor.args, true)})
    : super(_call('${c.name}.new', [${values(c.constructor.args)}]) as int);

${methods.join('\n\n')}
}`);
  }
  return contents.join('\n\n') + '\n';
}
