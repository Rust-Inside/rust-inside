use quote::ToTokens;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::{env, fs, process};
use syn::visit_mut::VisitMut;
use syn::{
    Attribute, Fields, FnArg, GenericArgument, ImplItem, Item, ItemImpl, ItemTrait, Meta, Pat,
    PathArguments, ReturnType, Signature, TraitItem, Type, UseTree, Visibility,
};

fn public(vis: &Visibility) -> bool {
    matches!(vis, Visibility::Public(_))
}

fn check_cfg(attrs: &[Attribute], name: &str) -> Result<(), String> {
    if attrs
        .iter()
        .any(|a| a.path().is_ident("cfg") || a.path().is_ident("cfg_attr"))
    {
        return Err(format!("{name}: keep the SDK declaration available on all platforms; place cfg on its implementation"));
    }
    Ok(())
}

const SELECTORS: &[&str] = &["app", "web", "ios", "android", "flutter", "server"];

fn marker(attr: &Attribute) -> Option<String> {
    let path = &attr.path().segments;
    let name = path.last()?.ident.to_string();
    if path.len() == 2 && path.first()?.ident == "rust_inside" {
        Some(name)
    } else {
        None
    }
}

fn unconditional(attrs: &[Attribute], name: &str) -> Result<(), String> {
    check_cfg(attrs, name)?;
    if attrs.iter().any(|attr| marker(attr).is_some()) {
        return Err(format!(
            "{name}: put platform attributes on a public API function or client method, a public module, a client impl, or a public SDK trait"
        ));
    }
    Ok(())
}

fn platform_scope(
    attrs: &[Attribute],
    name: &str,
    inherited: &[String],
) -> Result<Vec<String>, String> {
    check_cfg(attrs, name)?;
    let mut platforms = Vec::new();
    for attr in attrs {
        if let Some(selector) = marker(attr) {
            if !SELECTORS.contains(&selector.as_str()) {
                return Err(format!("{name}: unknown platform {selector}"));
            }
            if !matches!(attr.meta, Meta::Path(_)) {
                return Err(format!(
                    "{name}: platform attribute {selector} takes no arguments"
                ));
            }
            if platforms.contains(&selector) {
                return Err(format!("{name}: duplicate platform selector {selector}"));
            }
            platforms.push(selector);
        }
    }
    if platforms.is_empty() {
        return Ok(inherited.to_vec());
    }
    Ok(platforms)
}

fn selected(
    attrs: &[Attribute],
    name: &str,
    inherited: &[String],
    api: Value,
) -> Result<Value, String> {
    let platforms = platform_scope(attrs, name, inherited)?;
    Ok(with_platforms(api, &platforms))
}

fn with_platforms(mut api: Value, platforms: &[String]) -> Value {
    if !platforms.is_empty() {
        api["platforms"] = json!(platforms);
    }
    api
}

// Track imports per module. An attribute path and the prefix of a use tree
// resolve through the same chain of enclosing modules.
#[derive(Clone)]
struct MarkerScope {
    module: String,
    names: BTreeSet<String>,
}

#[derive(Clone, Default)]
struct MarkerImports(Vec<MarkerScope>);

impl MarkerImports {
    fn at(&self, path: &[String]) -> Option<&BTreeSet<String>> {
        let mut depth = self.0.len().checked_sub(1)?;
        let mut parts = path.iter().map(String::as_str).peekable();
        match parts.peek().copied() {
            None => return Some(&self.0[depth].names),
            Some("crate") => {
                parts.next();
                depth = 0;
            }
            Some("self") => {
                parts.next();
            }
            Some("super") => {
                while parts.next_if_eq(&"super").is_some() {
                    depth = depth.checked_sub(1)?;
                }
            }
            _ => return None,
        }
        for name in parts {
            depth += 1;
            if self.0.get(depth)?.module != name {
                return None;
            }
        }
        Some(&self.0[depth].names)
    }

    fn is_marker(&self, path: &[String], name: &str) -> bool {
        path == ["rust_inside"] || self.at(path).is_some_and(|names| names.contains(name))
    }

    fn collect_use(
        &self,
        tree: &UseTree,
        path: &mut Vec<String>,
        explicit: &mut BTreeMap<String, bool>,
        globs: &mut BTreeSet<String>,
    ) -> Result<(), String> {
        match tree {
            UseTree::Path(p) => {
                path.push(p.ident.to_string());
                self.collect_use(&p.tree, path, explicit, globs)?;
                path.pop();
            }
            UseTree::Group(group) => {
                for item in &group.items {
                    self.collect_use(item, path, explicit, globs)?;
                }
            }
            UseTree::Name(n) => {
                let name = n.ident.to_string();
                let marker = self.is_marker(path, &name);
                explicit.insert(name, marker);
            }
            UseTree::Rename(alias) => {
                if (path.is_empty() && alias.ident == "rust_inside")
                    || self.is_marker(path, &alias.ident.to_string())
                {
                    return Err("use platform attributes under their original names, e.g. #[rust_inside::app]".into());
                }
                explicit.insert(alias.rename.to_string(), false);
            }
            UseTree::Glob(_) => {
                if path == &["rust_inside"] {
                    globs.extend(SELECTORS.iter().map(|name| name.to_string()));
                } else if let Some(names) = self.at(path) {
                    globs.extend(names.iter().cloned());
                }
            }
        }
        Ok(())
    }

    fn for_items(&self, module: &str, items: &[Item]) -> Result<Self, String> {
        let mut imports = self.clone();
        imports.0.push(MarkerScope {
            module: module.rsplit("::").next().unwrap().into(),
            names: BTreeSet::new(),
        });
        // An import can refer back to this module (including a renamed marker).
        // Resolve again with the local bindings, independently of use-item order.
        loop {
            let names = imports.local_markers(items)?;
            let current = &mut imports.0.last_mut().unwrap().names;
            if *current == names {
                return Ok(imports);
            }
            *current = names;
        }
    }

    fn local_markers(&self, items: &[Item]) -> Result<BTreeSet<String>, String> {
        let mut globs = BTreeSet::new();
        let mut explicit = BTreeMap::new();
        for item in items {
            match item {
                Item::Use(u) => {
                    self.collect_use(&u.tree, &mut Vec::new(), &mut explicit, &mut globs)?
                }
                Item::ExternCrate(s) if s.ident == "rust_inside" && s.rename.is_some() => {
                    return Err("use platform attributes under their original names, e.g. #[rust_inside::app]".into());
                }
                _ => {}
            }
        }
        // A named import wins over a glob import, including an unrelated macro
        // with the same spelling as a Rust Inside selector.
        globs.retain(|name| !explicit.contains_key(name));
        globs.extend(
            explicit
                .into_iter()
                .filter_map(|(name, marker)| marker.then_some(name)),
        );
        Ok(globs)
    }
}

impl VisitMut for MarkerImports {
    // A module's declaration uses its parent's imports; its contents are
    // visited separately after processing its own imports.
    fn visit_item_mod_mut(&mut self, module: &mut syn::ItemMod) {
        for attr in &mut module.attrs {
            self.visit_attribute_mut(attr);
        }
    }

    fn visit_attribute_mut(&mut self, attr: &mut Attribute) {
        let path = attr.meta.path();
        let ident = &path.segments.last().unwrap().ident;
        let prefix: Vec<_> = path
            .segments
            .iter()
            .take(path.segments.len() - 1)
            .map(|segment| segment.ident.to_string())
            .collect();
        if self.is_marker(&prefix, &ident.to_string()) {
            let qualified = syn::parse_quote!(rust_inside::#ident);
            match &mut attr.meta {
                Meta::Path(path) => *path = qualified,
                Meta::List(list) => list.path = qualified,
                Meta::NameValue(pair) => pair.path = qualified,
            }
        }
    }
}

fn plain_type(ty: &Type) -> Option<String> {
    if let Type::Path(path) = ty {
        if path.qself.is_none() {
            return path.path.get_ident().map(ToString::to_string);
        }
    }
    None
}

fn type_name(ty: &Type) -> String {
    ty.to_token_stream().to_string().replace(' ', "")
}

fn signature(
    sig: &Signature,
    receiver: bool,
    asynchronous: bool,
) -> Result<(Value, String), String> {
    let name = &sig.ident;
    if sig.asyncness.is_some() != asynchronous
        || sig.unsafety.is_some()
        || sig.abi.is_some()
        || sig.variadic.is_some()
        || !sig.generics.params.is_empty()
        || sig.generics.where_clause.is_some()
    {
        return Err(format!("{name}: unsupported SDK signature; use plain sync free functions and constructors, and async client methods"));
    }
    let mut inputs = sig.inputs.iter();
    if receiver {
        match inputs.next() {
            Some(FnArg::Receiver(r))
                if r.reference
                    .as_ref()
                    .is_some_and(|(_, lifetime)| lifetime.is_none())
                    && r.colon_token.is_none()
                    && r.mutability.is_none() => {}
            _ => return Err(format!("{name}: a client method must receive &self")),
        }
    }
    let mut args = Map::new();
    for input in inputs {
        let FnArg::Typed(input) = input else {
            return Err(format!("{name}: unexpected self parameter"));
        };
        let Pat::Ident(arg) = &*input.pat else {
            return Err(format!(
                "{name}: use a named parameter for each SDK argument"
            ));
        };
        if arg.by_ref.is_some() || arg.subpat.is_some() {
            return Err(format!(
                "{name}: use a plain identifier for each SDK argument"
            ));
        }
        unconditional(&input.attrs, &arg.ident.to_string())?;
        args.insert(arg.ident.to_string(), json!(type_name(&input.ty)));
    }
    let output = match &sig.output {
        ReturnType::Default => "()".into(),
        ReturnType::Type(_, ty) => type_name(ty),
    };
    Ok((Value::Object(args), output))
}

fn record_result(sig: &Signature) -> Option<String> {
    let ReturnType::Type(_, ty) = &sig.output else {
        return None;
    };
    let Type::Path(ty) = &**ty else { return None };
    let seg = ty.path.segments.last()?;
    if seg.ident != "Result" || ty.qself.is_some() {
        return None;
    }
    let PathArguments::AngleBracketed(args) = &seg.arguments else {
        return None;
    };
    let mut args = args.args.iter();
    let (Some(GenericArgument::Type(result)), Some(GenericArgument::Type(error)), None) =
        (args.next(), args.next(), args.next())
    else {
        return None;
    };
    if plain_type(error).as_deref() == Some("String") {
        plain_type(result)
    } else {
        None
    }
}

fn client_methods(
    interface: &ItemTrait,
    implementation: &ItemImpl,
    inherited: &[String],
) -> Result<Vec<Value>, String> {
    let name = interface.ident.to_string();
    let trait_platforms = platform_scope(&interface.attrs, &name, inherited)?;
    let impl_platforms = platform_scope(&implementation.attrs, &name, &trait_platforms)?;
    if !interface.generics.params.is_empty()
        || interface.generics.where_clause.is_some()
        || !interface.supertraits.is_empty()
        || interface.unsafety.is_some()
    {
        return Err(format!(
            "{name}: SDK traits must have plain, non-generic methods"
        ));
    }
    // An implementation may supply per-platform method bodies with cfg. Only
    // bodies with SDK selectors participate in choosing the public signature.
    let mut overrides = BTreeMap::new();
    for item in &implementation.items {
        if let ImplItem::Fn(method) = item {
            if method.attrs.iter().any(|attr| marker(attr).is_some()) {
                let platforms = platform_scope(&method.attrs, &method.sig.ident.to_string(), &[])?;
                overrides.insert(&method.sig.ident, platforms);
            }
        }
    }
    let mut methods = Vec::new();
    for item in &interface.items {
        let TraitItem::Fn(method) = item else {
            return Err(format!(
                "{name}: only methods are supported in an SDK trait"
            ));
        };
        let method_platforms = platform_scope(
            &method.attrs,
            &method.sig.ident.to_string(),
            &impl_platforms,
        )?;
        let effective = overrides
            .remove(&method.sig.ident)
            .unwrap_or(method_platforms);
        methods.push(client_method(&name, &method.sig, &effective)?);
    }
    if let Some((method, _)) = overrides.first_key_value() {
        return Err(format!(
            "{name}: selected impl method {method} is missing from the public trait"
        ));
    }
    if methods.is_empty() {
        return Err(format!("{name}: declare at least one SDK method"));
    }
    Ok(methods)
}

fn client_method(owner: &str, sig: &Signature, platforms: &[String]) -> Result<Value, String> {
    let name = sig.ident.to_string();
    let (args, _) = signature(sig, true, true)?;
    let returns = record_result(sig).ok_or_else(|| {
        format!("{owner}::{name}: expected async fn with return type Result<Record, String>")
    })?;
    Ok(with_platforms(
        json!({"name": name, "args": args, "returns": returns, "async": true, "fallible": true}),
        platforms,
    ))
}

fn inherent_methods(
    owner: &str,
    impls: &[&ItemImpl],
    inherited: &[String],
) -> Result<Vec<Value>, String> {
    let mut methods = Vec::new();
    for implementation in impls {
        for item in &implementation.items {
            let ImplItem::Fn(method) = item else { continue };
            if !public(&method.vis) || method.sig.ident == "new" {
                continue;
            }
            let platforms = platform_scope(&implementation.attrs, owner, inherited)?;
            let method_platforms =
                platform_scope(&method.attrs, &method.sig.ident.to_string(), &platforms)?;
            methods.push(client_method(owner, &method.sig, &method_platforms)?);
        }
    }
    Ok(methods)
}

fn constructor(name: &str, impls: &[&ItemImpl]) -> Result<Value, String> {
    for implementation in impls {
        for item in &implementation.items {
            let ImplItem::Fn(method) = item else { continue };
            if method.sig.ident != "new" || !public(&method.vis) {
                continue;
            }
            platform_scope(&implementation.attrs, name, &[])?;
            check_cfg(&method.attrs, &format!("{name}::new"))?;
            if method.attrs.iter().any(|attr| marker(attr).is_some()) {
                return Err(format!("{name}::new: the constructor follows the selected client methods; put platform attributes on the methods or their enclosing scope"));
            }
            let (args, returns) = signature(&method.sig, false, false)?;
            if returns != "Self" && returns != name {
                return Err(format!("{name}::new: the SDK constructor must return Self"));
            }
            return Ok(json!({"args": args}));
        }
    }
    Err(format!(
        "{name}: expected pub fn new(...) -> Self in an inherent impl in the API file"
    ))
}

#[derive(Default)]
struct Surface {
    rpc: bool,
    exports: Vec<Value>,
    records: Vec<Value>,
    clients: Vec<Value>,
    enums: Vec<Value>,
}

fn rpc_enum(item: &syn::ItemEnum, module: &str, scope: &[String]) -> Result<Value, String> {
    let name = item.ident.to_string();
    unconditional(&item.attrs, &name)?;
    if !item.generics.params.is_empty()
        || item.generics.where_clause.is_some()
        || item.variants.is_empty()
    {
        return Err(format!("{name}: use a nonempty, nongeneric RPC enum"));
    }
    let mut variants = Vec::new();
    for variant in &item.variants {
        let case = variant.ident.to_string();
        unconditional(&variant.attrs, &format!("{name}::{case}"))?;
        if !matches!(variant.fields, Fields::Unit) || variant.discriminant.is_some() {
            return Err(format!(
                "{name}::{case}: RPC enum cases must be plain unit variants"
            ));
        }
        variants.push(case);
    }
    let mut definition = json!({
        "name": name, "path": format!("{module}::{name}"), "variants": variants
    });
    if !scope.is_empty() {
        definition["platforms"] = json!(scope);
    }
    Ok(definition)
}

fn discover_items(
    items: &[Item],
    module: &str,
    scope: &[String],
    surface: &mut Surface,
) -> Result<(), String> {
    let mut traits = BTreeMap::new();
    let mut structs = BTreeMap::new();
    let mut implementations = Vec::new();
    let mut inherent: BTreeMap<String, Vec<&ItemImpl>> = BTreeMap::new();
    let local_types: BTreeSet<_> = items
        .iter()
        .filter_map(|item| match item {
            Item::Struct(s) => Some(&s.ident),
            Item::Union(s) => Some(&s.ident),
            Item::Enum(s) => Some(&s.ident),
            Item::Type(s) => Some(&s.ident),
            _ => None,
        })
        .map(ToString::to_string)
        .collect();
    for item in items {
        match item {
            Item::Struct(s) if public(&s.vis) => {
                let name = s.ident.to_string();
                unconditional(&s.attrs, &name)?;
                if !s.generics.params.is_empty() || s.generics.where_clause.is_some() {
                    return Err(format!("{name}: SDK structs cannot be generic"));
                }
                structs.insert(name, s);
            }
            Item::Trait(t) if public(&t.vis) => {
                traits.insert(t.ident.to_string(), t);
            }
            Item::Impl(i) if i.trait_.is_some() => implementations.push(i),
            Item::Impl(i) => {
                let Type::Path(owner) = &*i.self_ty else {
                    continue;
                };
                let segments: Vec<_> = owner
                    .path
                    .segments
                    .iter()
                    .map(|seg| seg.ident.to_string())
                    .collect();
                let path = segments.join("::");
                let name = path
                    .strip_prefix(&format!("crate::{module}::"))
                    .or_else(|| path.strip_prefix("self::"))
                    .unwrap_or(&path);
                if local_types.contains(name) {
                    inherent.entry(name.to_owned()).or_default().push(i);
                    continue;
                }
                let scoped = !scope.is_empty() || i.attrs.iter().any(|attr| marker(attr).is_some());
                for item in &i.items {
                    let ImplItem::Fn(method) = item else { continue };
                    if public(&method.vis)
                        && (scoped
                            || method.sig.asyncness.is_some()
                            || method.attrs.iter().any(|attr| marker(attr).is_some()))
                    {
                        return Err(format!("{module}: place impl {path} containing SDK method {} in the same Rust module as its public client struct", method.sig.ident));
                    }
                }
            }
            Item::Fn(f) if public(&f.vis) => {
                let name = f.sig.ident.to_string();
                let (args, returns) = signature(&f.sig, false, false)?;
                surface.exports.push(selected(&f.attrs, &name, scope, json!({"name":name, "path":format!("{module}::{name}"), "args":args, "returns":returns}))?);
            }
            Item::Enum(s) if public(&s.vis) => {
                if !surface.rpc {
                    return Err(format!("{}: exported enums are unsupported", s.ident));
                }
                surface.enums.push(rpc_enum(s, module, scope)?);
            }
            Item::Const(s) if public(&s.vis) => {
                return Err(format!(
                    "{}: use a public function to expose an SDK constant",
                    s.ident
                ))
            }
            Item::Static(s) if public(&s.vis) => {
                return Err(format!(
                    "{}: use a public function to expose an SDK value",
                    s.ident
                ))
            }
            Item::Union(s) if public(&s.vis) => {
                return Err(format!("{}: use a named struct for an SDK record", s.ident))
            }
            Item::Type(s) if public(&s.vis) => {
                return Err(format!(
                    "{}: declare the concrete record or client in the API file",
                    s.ident
                ))
            }
            Item::Use(s) if public(&s.vis) => {
                return Err(
                    "declare SDK items in this API file; pub use re-exports are unsupported".into(),
                )
            }
            _ => {}
        }
    }
    let mut client_names = BTreeSet::new();
    let mut linked_traits = BTreeSet::new();
    for implementation in implementations {
        let (_, path, _) = implementation.trait_.as_ref().unwrap();
        let Some(trait_name) = path.get_ident().map(ToString::to_string) else {
            continue;
        };
        let Some(interface) = traits.get(&trait_name) else {
            continue;
        };
        let name = plain_type(&implementation.self_ty)
            .ok_or_else(|| format!("{trait_name}: expected impl {trait_name} for Client"))?;
        if !structs.contains_key(&name) {
            return Err(format!(
                "{trait_name}: declare public client struct {name} in the API file"
            ));
        }
        if !client_names.insert(name.clone()) {
            return Err(format!("{name}: use one SDK trait per client"));
        }
        let client = json!({
            "name": name, "traitName": trait_name, "constructor": constructor(&name, inherent.get(&name).map(Vec::as_slice).unwrap_or_default())?,
            "path": format!("{module}::{name}"), "traitPath": format!("{module}::{trait_name}"),
            "methods": client_methods(interface, implementation, scope)?,
        });
        surface.clients.push(client);
        linked_traits.insert(trait_name);
    }
    for name in traits.keys() {
        if !linked_traits.contains(name) {
            return Err(format!(
                "{name}: place impl {name} for Client in the same API file"
            ));
        }
    }
    for (name, item) in structs {
        if client_names.contains(&name) {
            continue;
        }
        let impls = inherent.get(&name).map(Vec::as_slice).unwrap_or_default();
        let methods = inherent_methods(&name, impls, scope)?;
        if !methods.is_empty() {
            surface.clients.push(json!({
                "name": name, "path": format!("{module}::{name}"),
                "constructor": constructor(&name, impls)?, "methods": methods,
            }));
            continue;
        }
        let Fields::Named(fields) = &item.fields else {
            return Err(format!("{name}: SDK records must have named public fields"));
        };
        let mut properties = Vec::new();
        for field in &fields.named {
            let field_name = field.ident.as_ref().unwrap().to_string();
            unconditional(&field.attrs, &field_name)?;
            if !public(&field.vis) {
                return Err(format!("{name}.{field_name}: record fields must be public; for private client state, place the SDK impl with its public async methods or SDK trait in the same Rust module as the client struct"));
            }
            properties.push(json!({"name": field_name, "type": type_name(&field.ty)}));
        }
        let mut record =
            json!({"name":name, "path":format!("{module}::{name}"), "fields":properties});
        if !scope.is_empty() {
            record["platforms"] = json!(scope);
        }
        surface.records.push(record);
    }
    Ok(())
}

// Rust resolves a plain "mod x;" against the logical module directory, but
// #[path] in an external source file is relative to the containing file.
struct ModuleDirs {
    children: PathBuf,
    attributes: PathBuf,
}

impl ModuleDirs {
    fn at_file(path: &Path, use_parent: bool) -> Self {
        let parent = path.parent().unwrap();
        let children = if use_parent || path.file_name().is_some_and(|name| name == "mod.rs") {
            parent.to_owned()
        } else {
            path.with_extension("")
        };
        Self {
            children,
            attributes: parent.to_owned(),
        }
    }

    fn external(&self, name: &str, specified: Option<&Path>) -> Result<PathBuf, String> {
        if let Some(path) = specified {
            return Ok(self.attributes.join(path));
        }
        let flat = self.children.join(format!("{name}.rs"));
        let nested = self.children.join(name).join("mod.rs");
        match (flat.is_file(), nested.is_file()) {
            (true, false) => Ok(flat),
            (false, true) => Ok(nested),
            (true, true) => Err(format!(
                "{name}: both {} and {} exist",
                flat.display(),
                nested.display()
            )),
            (false, false) => Err(format!(
                "{name}: module source not found at {} or {}",
                flat.display(),
                nested.display()
            )),
        }
    }
}

fn module_path(attrs: &[Attribute]) -> Result<Option<PathBuf>, String> {
    let Some(attr) = attrs.iter().find(|attr| attr.path().is_ident("path")) else {
        return Ok(None);
    };
    if let Meta::NameValue(meta) = &attr.meta {
        if let syn::Expr::Lit(expr) = &meta.value {
            if let syn::Lit::Str(path) = &expr.lit {
                return Ok(Some(PathBuf::from(path.value())));
            }
        }
    }
    Err("expected #[path = \"file.rs\"] on an SDK module".into())
}

fn read_source(path: &Path) -> Result<syn::File, String> {
    let source =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    syn::parse_file(&source)
        .map_err(|error| format!("{}: invalid Rust source: {error}", path.display()))
}

fn file_id(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("{}: {error}", path.display()))
}

struct Discovery {
    surface: Surface,
    open_files: BTreeSet<PathBuf>,
}

impl Discovery {
    fn items(
        &mut self,
        items: &mut [Item],
        module: &str,
        dirs: &ModuleDirs,
        scope: &[String],
        parent: &MarkerImports,
    ) -> Result<(), String> {
        let mut imports = parent.for_items(module, items)?;
        for item in items.iter_mut() {
            imports.visit_item_mut(item);
        }
        discover_items(items, module, scope, &mut self.surface)?;
        for item in items {
            if let Item::Mod(child) = item {
                if public(&child.vis) {
                    let name = format!("{module}::{}", child.ident);
                    self.module(child, &name, dirs, scope, &imports, None)?;
                }
            }
        }
        Ok(())
    }

    fn module(
        &mut self,
        item: &mut syn::ItemMod,
        module: &str,
        dirs: &ModuleDirs,
        inherited: &[String],
        parent: &MarkerImports,
        expected_file: Option<&Path>,
    ) -> Result<(), String> {
        let scope = platform_scope(&item.attrs, module, inherited)?;
        let specified = module_path(&item.attrs)?;
        let name = item.ident.to_string();
        let name = name.trim_start_matches("r#");
        if let Some((_, items)) = &mut item.content {
            let directory = match specified {
                Some(path) => dirs.attributes.join(path),
                None => dirs.children.join(name),
            };
            let inline_dirs = ModuleDirs {
                children: directory.clone(),
                attributes: directory,
            };
            return self.items(items, module, &inline_dirs, &scope, parent);
        }
        let path = dirs.external(name, specified.as_deref())?;
        let id = file_id(&path)?;
        if expected_file.is_some_and(|expected| expected != id) {
            return Err(format!(
                "the configured API file must match pub mod api at {}",
                path.display()
            ));
        }
        if !self.open_files.insert(id.clone()) {
            return Err(format!(
                "{module}: cycle in module source files at {}",
                path.display()
            ));
        }
        let mut file = read_source(&path)?;
        unconditional(&file.attrs, module)?;
        self.items(
            &mut file.items,
            module,
            &ModuleDirs::at_file(&path, specified.is_some()),
            &scope,
            parent,
        )?;
        self.open_files.remove(&id);
        Ok(())
    }
}

fn discover(
    path: &Path,
    crate_root: Option<&Path>,
    rpc: bool,
    allow_empty: bool,
) -> Result<Value, String> {
    let mut discovery = Discovery {
        surface: Surface {
            rpc,
            ..Surface::default()
        },
        open_files: BTreeSet::new(),
    };
    let empty = MarkerImports::default();
    let api_id = file_id(path)?;
    if let Some(root) = crate_root {
        let root_id = file_id(root)?;
        discovery.open_files.insert(root_id.clone());
        let mut file = read_source(root)?;
        let mut imports = empty.for_items("", &file.items)?;
        let mut roots = file.items.iter_mut().filter_map(|item| match item {
            Item::Mod(m) if m.ident == "api" => Some(m),
            _ => None,
        });
        let api = roots
            .next()
            .ok_or("declare pub mod api in the crate root")?;
        if !public(&api.vis) || roots.next().is_some() {
            return Err("declare one unconditional pub mod api in the crate root".into());
        }
        if api.content.is_some() && root_id != api_id {
            return Err(
                "for an inline pub mod api, set the configured API file to the crate root".into(),
            );
        }
        imports.visit_item_mod_mut(api);
        discovery.module(
            api,
            "api",
            &ModuleDirs::at_file(root, true),
            &[],
            &imports,
            Some(&api_id),
        )?;
    } else {
        discovery.open_files.insert(api_id);
        let mut file = read_source(path)?;
        unconditional(&file.attrs, "API file")?;
        discovery.items(
            &mut file.items,
            "api",
            &ModuleDirs::at_file(path, false),
            &[],
            &empty.for_items("", &[])?,
        )?;
    }
    let Surface {
        exports,
        records,
        clients,
        enums,
        ..
    } = discovery.surface;
    if !allow_empty && exports.is_empty() && clients.is_empty() {
        return Err("declare a public function or a client with async methods".into());
    }
    let mut api = json!({"module":"api", "exports":exports, "records":records, "clients":clients});
    if rpc {
        api["enums"] = json!(enums);
    }
    Ok(api)
}

fn main() {
    let mut args: Vec<_> = env::args_os().skip(1).map(PathBuf::from).collect();
    let allow_empty = args
        .last()
        .is_some_and(|arg| arg == Path::new("--allow-empty"));
    if allow_empty {
        args.pop();
    }
    let rpc = args.last().is_some_and(|arg| arg == Path::new("--rpc"));
    if rpc {
        args.pop();
    }
    let path = args.first().expect("pass the Rust API file path");
    let result = discover(path, args.get(1).map(PathBuf::as_path), rpc, allow_empty);
    match result {
        Ok(api) => println!("{api}"),
        Err(error) => {
            eprintln!("{}: {error}", path.display());
            process::exit(1)
        }
    }
}
