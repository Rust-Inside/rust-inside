// The Flutter adapter owns the C strings it returns. Its JSON payload is private to
// the generated Dart library, so producers need no FFI or serde annotations.
const camel = name => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

function readArgument(type, index) {
  const value = `value(args, ${index})?`;
  if (type === 'u64') return `${value}.as_str().ok_or("Expected a u64 string")?.parse::<u64>().map_err(|e| e.to_string())?`;
  if (type === 'f32' || type === 'f64') return `${value}.as_str().ok_or("Expected a floating-point string")?.parse::<${type}>().map_err(|e| e.to_string())?`;
  return `serde_json::from_value::<${type}>(${value}.clone()).map_err(|e| e.to_string())?`;
}

function toWire(type, value) {
  if (type === 'u64' || type === 'f32' || type === 'f64') return `(${value}).to_string()`;
  return value;
}

function argsFor(args, offset = 0) {
  return Object.values(args).map((type, index) => readArgument(type, index + offset)).join(', ');
}

export function flutterNativeSource(sdk) {
  const { exports, clients = [], records = [], flutterLibrary: library } = sdk;
  const arms = exports.map(fn => {
    const call = `sdk_core::${fn.path}(${argsFor(fn.args)})`;
    return `        "${fn.name}" => Ok(json!(${toWire(fn.returns, call)})),`;
  });
  let registry = '';
  if (clients.length) {
    registry = `
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::sync::atomic::{AtomicI64, Ordering};

#[derive(Clone)]
enum Client {
${clients.map(c => `    ${c.name}(Arc<sdk_core::${c.path}>),`).join('\n')}
}

static CLIENTS: LazyLock<Mutex<HashMap<i64, Client>>> = LazyLock::new(Default::default);
static NEXT: AtomicI64 = AtomicI64::new(1);
static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Runtime::new().expect("Cannot start Flutter SDK runtime")
});
`;
    arms.push(`        "_close" => {
            let id = value(args, 0)?.as_i64().ok_or("Invalid client handle")?;
            CLIENTS.lock().map_err(|_| "Client registry unavailable")?.remove(&id);
            Ok(Value::Null)
        },`);
    for (const client of clients) {
      arms.push(`        "${client.name}.new" => {
            let _context = RUNTIME.enter();
            let client = sdk_core::${client.path}::new(${argsFor(client.constructor.args)});
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            CLIENTS.lock().map_err(|_| "Client registry unavailable")?.insert(id, Client::${client.name}(Arc::new(client)));
            Ok(json!(id))
        },`);
      for (const method of client.methods) {
        const record = records.find(r => r.name === method.returns);
        if (!record) throw new Error(`Missing Flutter record ${method.returns}`);
        const fields = record.fields.map(f => `                "${camel(f.name)}": ${toWire(f.type, 'result.' + f.name)},`).join('\n');
        const args = argsFor(method.args, 1);
        const call = client.traitPath
          ? `sdk_core::${client.traitPath}::${method.name}(&*client${args ? ', ' + args : ''})`
          : `client.${method.name}(${args})`;
        arms.push(`        "${client.name}.${method.name}" => {
            let id = value(args, 0)?.as_i64().ok_or("Invalid client handle")?;
            let entry = CLIENTS.lock().map_err(|_| "Client registry unavailable")?.get(&id).cloned();
            let Some(Client::${client.name}(client)) = entry else { return Err("Invalid or closed client".into()); };
            let result = RUNTIME.block_on(${call})?;
            Ok(json!({
${fields}
            }))
        },`);
      }
    }
  }
  return `use serde_json::{json, Value};
use std::ffi::{CStr, CString, c_char};
${registry}
#[allow(dead_code)]
fn value(args: &[Value], index: usize) -> Result<&Value, String> {
    args.get(index).ok_or_else(|| format!("Missing SDK argument {index}"))
}

fn dispatch(request: &str) -> Result<Value, String> {
    let message: Vec<Value> = serde_json::from_str(request).map_err(|e| e.to_string())?;
    let (method, args) = message.split_first().ok_or("Empty SDK request")?;
    let _ = args;
    match method.as_str().ok_or("Expected SDK method")? {
${arms.join('\n')}
        _ => Err("Unknown SDK method".into()),
    }
}

/// Input must be a valid NUL-terminated UTF-8 string for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ${library}_call(input: *const c_char) -> *mut c_char {
    let outcome = std::panic::catch_unwind(|| {
        if input.is_null() { return Err("Missing SDK request".to_string()); }
        let text = unsafe { CStr::from_ptr(input) }.to_str().map_err(|e| e.to_string())?;
        dispatch(text)
    }).unwrap_or_else(|_| Err("Rust SDK call panicked".into()));
    let response = match outcome {
        Ok(value) => json!({"value": value}),
        Err(error) => json!({"error": error}),
    };
    CString::new(response.to_string()).expect("JSON escapes NUL").into_raw()
}

/// Releases exactly one response previously returned by the call entry point.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ${library}_free(response: *mut c_char) {
    if !response.is_null() { drop(unsafe { CString::from_raw(response) }); }
}
`;
}
