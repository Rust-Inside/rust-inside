const camelCase = name => name.replace(/_([a-z0-9])/g, (_, next) => next.toUpperCase());
const parameters = args => Object.entries(args).map(([name, type]) => `${name}: ${type}`).join(', ');

function freeFunction({ path, name, jsName, args, returns }, native) {
  const attribute = native ? '#[uniffi::export]' : `#[wasm_bindgen(js_name = ${jsName})]`;
  const result = returns === '()' ? '' : ` -> ${returns}`;
  const call = `sdk_core::${path}(${Object.keys(args).join(', ')})`;
  return `${attribute}
pub fn ${name}(${parameters(args)})${result} {
    ${call}
}`;
}

function recordType({ name, path, fields }, native) {
  const attr = native ? '#[derive(uniffi::Record)]' : '#[wasm_bindgen(getter_with_clone)]';
  const definitions = fields.map(field => {
    const jsAttr = native ? '' : `    #[wasm_bindgen(readonly, js_name = ${camelCase(field.name)})]\n`;
    return jsAttr + `    pub ${field.name}: ${field.type},`;
  }).join('\n');
  const assignments = fields.map(field => `            ${field.name}: value.${field.name},`).join('\n');
  return `${attr}
pub struct ${name} {
${definitions}
}

impl From<sdk_core::${path}> for ${name} {
    fn from(value: sdk_core::${path}) -> Self {
        Self {
${assignments}
        }
    }
}`;
}

function clientMethod({ name, jsName, args, returns }, traitPath, native) {
  const receiver = ['&self', ...Object.entries(args).map(([arg, type]) => `${arg}: ${type}`)];
  const call = traitPath
    ? `sdk_core::${traitPath}::${name}(${['&self.inner', ...Object.keys(args)].join(', ')})`
    : `self.inner.${name}(${Object.keys(args).join(', ')})`;
  const attr = native ? '' : `    #[wasm_bindgen(js_name = ${jsName})]\n`;
  const error = native ? 'RustInsideCallError' : 'wasm_bindgen::JsError';
  const mapError = native ? '|message| RustInsideCallError::Failed { message }' : '|message| wasm_bindgen::JsError::new(&message)';
  return `${attr}    pub async fn ${name}(${receiver.join(', ')}) -> Result<${returns}, ${error}> {
        ${call}
            .await
            .map(Into::into)
            .map_err(${mapError})
    }`;
}

function clientType({ name, path, traitPath, constructor, methods }, native) {
  const attr = native ? '#[derive(uniffi::Object)]' : '#[wasm_bindgen]';
  const implAttr = native ? '#[uniffi::export(async_runtime = "tokio")]' : '#[wasm_bindgen]';
  const newAttr = native ? '#[uniffi::constructor]' : '#[wasm_bindgen(constructor)]';
  const result = native ? 'std::sync::Arc<Self>' : 'Self';
  const newValue = native ? 'std::sync::Arc::new(Self { inner })' : 'Self { inner }';
  const args = Object.keys(constructor.args).join(', ');
  return `${attr}
pub struct ${name} {
    inner: sdk_core::${path},
}

${implAttr}
impl ${name} {
    ${newAttr}
    pub fn new(${parameters(constructor.args)}) -> ${result} {
        let inner = sdk_core::${path}::new(${args});
        ${newValue}
    }

${methods.map(method => clientMethod(method, traitPath, native)).join('\n\n')}
}`;
}

export function wrapperSource({ exports, records = [], clients = [] }, native) {
  const source = [native ? 'uniffi::setup_scaffolding!();' : 'use wasm_bindgen::prelude::wasm_bindgen;'];
  if (native && clients.length) {
    source.push(`#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum RustInsideCallError {
    #[error("{message}")]
    Failed { message: String },
}`);
  }
  source.push(...records.map(record => recordType(record, native)));
  source.push(...clients.map(client => clientType(client, native)));
  source.push(...exports.map(fn => freeFunction(fn, native)));
  return source.join('\n\n') + '\n';
}
