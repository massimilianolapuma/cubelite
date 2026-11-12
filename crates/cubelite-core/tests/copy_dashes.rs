//! Copy that reaches the user never uses an em dash as punctuation (Tonal
//! spec §6, as `apps/desktop/src/lib/copy-dashes.test.ts` holds for the
//! desktop sources). Error messages from the core and the Tauri commands are
//! shown in toasts, cells and dialogs, so every string literal of both crates
//! is checked, outside comments, doc comments and test code.

use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use proc_macro2::{Delimiter, TokenStream, TokenTree};

const EM_DASH: char = '\u{2014}';

/// Every `.rs` file under `dir`, recursively.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Whether a literal, as written in the source, holds an em dash (raw or escaped).
fn has_em_dash(literal: &str) -> bool {
    literal.contains(EM_DASH) || literal.to_lowercase().contains("\\u{2014}")
}

/// The first identifier of an attribute's bracket group: `doc`, `cfg`, `test`…
fn attribute_name(group: &proc_macro2::Group) -> Option<String> {
    match group.stream().into_iter().next() {
        Some(TokenTree::Ident(ident)) => Some(ident.to_string()),
        _ => None,
    }
}

/// `#[cfg(test)]` or `#[test]`: the item after it is test code.
fn is_test_attribute(group: &proc_macro2::Group) -> bool {
    let text = group.stream().to_string().replace(' ', "");
    text == "test" || text == "cfg(test)" || text.starts_with("tokio::test")
}

/// The string literals of `stream` that hold an em dash, skipping doc comments
/// (`#[doc = "…"]` once lexed) and every item marked as test code.
fn em_dash_literals(stream: TokenStream, found: &mut Vec<String>) {
    let tokens: Vec<TokenTree> = stream.into_iter().collect();
    let mut i = 0;
    let mut skip_item = false;
    while i < tokens.len() {
        match &tokens[i] {
            TokenTree::Punct(p) if p.as_char() == '#' => {
                // `#[…]` or `#![…]`.
                let mut j = i + 1;
                if let Some(TokenTree::Punct(bang)) = tokens.get(j) {
                    if bang.as_char() == '!' {
                        j += 1;
                    }
                }
                if let Some(TokenTree::Group(group)) = tokens.get(j) {
                    if group.delimiter() == Delimiter::Bracket {
                        if is_test_attribute(group) {
                            skip_item = true;
                        }
                        if attribute_name(group).as_deref() != Some("doc") {
                            em_dash_literals(group.stream(), found);
                        }
                        i = j + 1;
                        continue;
                    }
                }
                i += 1;
            }
            TokenTree::Group(group) => {
                if skip_item && group.delimiter() == Delimiter::Brace {
                    // The body of the test item: skipped whole.
                    skip_item = false;
                } else if !skip_item {
                    em_dash_literals(group.stream(), found);
                }
                i += 1;
            }
            TokenTree::Punct(p) if skip_item && p.as_char() == ';' => {
                // A test item with no body (`#[cfg(test)] mod tests;`, a `use`).
                skip_item = false;
                i += 1;
            }
            TokenTree::Literal(literal) if !skip_item => {
                let text = literal.to_string();
                if has_em_dash(&text) {
                    found.push(text);
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
}

fn violations(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    rust_files(root, &mut files);
    files.sort();
    let mut out = Vec::new();
    for file in files {
        let source =
            fs::read_to_string(&file).unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
        let stream = TokenStream::from_str(&source)
            .unwrap_or_else(|e| panic!("lex {}: {e:?}", file.display()));
        let mut found = Vec::new();
        em_dash_literals(stream, &mut found);
        out.extend(
            found
                .into_iter()
                .map(|lit| format!("{}: {lit}", file.display())),
        );
    }
    out
}

fn lexed(source: &str) -> Vec<String> {
    let mut found = Vec::new();
    em_dash_literals(TokenStream::from_str(source).expect("lex"), &mut found);
    found
}

#[test]
fn the_check_sees_literals_and_skips_comments_docs_and_tests() {
    let source = r##"
        //! Module doc — fine.
        /// Item doc — fine.
        // Line comment — fine.
        /* Block comment — fine. */
        fn shown() -> String { format!("failed — {}", 1) }
        const RAW: &str = r#"raw — string"#;
        const ESCAPED: &str = "escaped \u{2014} dash";
        #[derive(Debug, thiserror::Error)]
        enum E { #[error("attribute — message")] A }
        fn plain() -> &'static str { "no dash: fine" }
        #[cfg(test)]
        mod tests {
            #[test]
            fn t() { assert_eq!(super::shown(), "failed — 1"); }
        }
        #[test]
        fn outside() { let _ = "test fn — fine"; }
        fn after() -> char { '—' }
    "##;
    assert_eq!(
        lexed(source),
        vec![
            "\"failed — {}\"",
            "r#\"raw — string\"#",
            "\"escaped \\u{2014} dash\"",
            "\"attribute — message\"",
            "'—'",
        ]
    );
}

#[test]
fn no_em_dash_in_a_string_of_the_core_or_the_tauri_commands() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let roots = [
        manifest.join("src"),
        manifest.join("../../apps/desktop/src-tauri/src"),
    ];
    let found: Vec<String> = roots.iter().flat_map(|root| violations(root)).collect();
    assert!(
        found.is_empty(),
        "em dash in user-facing strings (use a colon, a comma or a full stop; an empty value is the UI's en dash):\n{}",
        found.join("\n")
    );
}
