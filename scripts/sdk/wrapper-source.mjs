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

function rpcEnum({ name, path, variants }) {
  const core = `sdk_core::${path}`;
  const from = variants.map(variant => `            ${core}::${variant} => Self::${variant},`).join('\n');
  const to = variants.map(variant => `            ${name}::${variant} => Self::${variant},`).join('\n');
  return `#[derive(uniffi::Enum)]
pub enum ${name} {
${variants.map(variant => `    ${variant},`).join('\n')}
}

impl From<${core}> for ${name} {
    fn from(value: ${core}) -> Self {
        match value {
${from}
        }
    }
}

impl From<${name}> for ${core} {
    fn from(value: ${name}) -> Self {
        match value {
${to}
        }
    }
}`;
}

function rpcRecord({ name, path, fields }) {
  const core = `sdk_core::${path}`;
  const assignments = fields.map(({ name }) => `            ${name}: value.${name}.into(),`).join('\n');
  const convert = (from, to) => `impl From<${from}> for ${to} {
    fn from(value: ${from}) -> Self {
        Self {
${assignments}
        }
    }
}`;
  return `#[derive(uniffi::Record)]
pub struct ${name} {
${fields.map(({ name, type }) => `    pub ${name}: ${type},`).join('\n')}
}

${convert(core, name)}

${convert(name, core)}`;
}

export function rpcWrapperSource({ exports, records, enums }) {
  const functions = exports.map(({ path, name, args, returns }) => `#[uniffi::export]
pub fn ${name}(${parameters(args)}) -> ${returns} {
    sdk_core::${path}(${Object.keys(args).map(arg => `${arg}.into()`).join(', ')}).into()
}`);
  return ['uniffi::setup_scaffolding!();', ...enums.map(rpcEnum), ...records.map(rpcRecord), ...functions].join('\n\n') + '\n';
}
