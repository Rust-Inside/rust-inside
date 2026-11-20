//! Selects which Rust Inside packages expose a public Rust API.
//! Put `#[rust_inside::app]` on a public module, a client's `impl`, or a public SDK trait
//! to select iOS, Android, and Flutter for its public API. A nested scope, function,
//! or method can override that selection. Stack attributes on the same declaration to
//! select multiple groups. A trait method's selectors override the implementation block's
//! defaults. Selectors on the implementing method override the trait method's selectors.
//! The generator includes a client's constructor on every platform with a selected method.
//! These attributes preserve Rust signatures and visibility. Qualified attributes and
//! attributes imported under their original names in the same module are supported.

use proc_macro::TokenStream;

macro_rules! markers {
    ($($name:ident),*) => {
        $(
            #[proc_macro_attribute]
            pub fn $name(args: TokenStream, item: TokenStream) -> TokenStream {
                if args.is_empty() {
                    item
                } else {
                    "compile_error!(\"Rust Inside platform attributes take no arguments\");"
                        .parse()
                        .unwrap()
                }
            }
        )*
    };
}

markers!(app, web, ios, android, flutter, server);
