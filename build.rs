//! Generates `wire.rs` (into `OUT_DIR`) from the server's wire schema, so the
//! client's types are the server's types. Regenerate the schema with
//! `bun run codegen` in `server/`.

use std::{env, fs, path::Path};

const SCHEMA: &str = "server/generated/wire.schema.json";

fn main() {
    println!("cargo::rerun-if-changed={SCHEMA}");
    let text = fs::read_to_string(SCHEMA).expect("read the wire schema");
    let schema: schemars::schema::RootSchema =
        serde_json::from_str(&text).expect("parse the wire schema");

    let mut types =
        typify::TypeSpace::new(typify::TypeSpaceSettings::default().with_struct_builder(false));
    types
        .add_root_schema(schema)
        .expect("convert the wire schema");
    let file: syn::File = syn::parse2(types.to_stream()).expect("parse the generated types");

    let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("wire.rs");
    fs::write(out, prettyplease::unparse(&file)).expect("write wire.rs");
}
