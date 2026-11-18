//! The macOS write of a copied Secret value (#661, spec §6.2).
//!
//! Why this exists: on macOS the general pasteboard travels to the user's
//! other Apple devices (Universal Clipboard, Handoff) unless its contents
//! are prepared as current-host-only, and `arboard` has no way to ask for
//! that. A copied Secret value must stay on this Mac, so the write goes to
//! `NSPasteboard` directly: `prepareForNewContentsWithOptions` with
//! `NSPasteboardContentsCurrentHostOnly` (which also empties the
//! pasteboard), the text, and the `org.nspasteboard.ConcealedType` mark that
//! clipboard managers follow (<http://nspasteboard.org>). Reading the
//! pasteboard back and clearing it stay on `arboard`.
//!
//! This is the feature's only platform code.

use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSPasteboard, NSPasteboardContentsOptions, NSPasteboardTypeString};
use objc2_foundation::{ns_string, NSString};

/// Write `text` to the general pasteboard for this Mac only, concealed.
pub(super) fn write_current_host_only(text: &str) -> Result<(), String> {
    autoreleasepool(|_| {
        let board = NSPasteboard::generalPasteboard();
        board.prepareForNewContentsWithOptions(NSPasteboardContentsOptions::CurrentHostOnly);
        // SAFETY: `NSPasteboardTypeString` is an immutable `NSString` constant
        // AppKit defines for the life of the process; reading it is sound.
        let string_type = unsafe { NSPasteboardTypeString };
        let written = board.setString_forType(&NSString::from_str(text), string_type);
        let concealed =
            board.setString_forType(ns_string!(""), ns_string!("org.nspasteboard.ConcealedType"));
        if written && concealed {
            Ok(())
        } else {
            Err("Could not write the clipboard".to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes the real pasteboard, so it is not run by default: run it by
    /// hand (`cargo test -p cubelite-desktop -- --ignored macos`) and check
    /// that the text and the concealed mark are there. Whether the content is
    /// kept off Universal Clipboard can only be seen with a second device.
    #[test]
    #[ignore = "writes the real pasteboard"]
    fn writes_the_text_and_the_concealed_mark() {
        write_current_host_only("cubelite-pasteboard-check").expect("write");
        let board = NSPasteboard::generalPasteboard();
        // SAFETY: as above.
        let string_type = unsafe { NSPasteboardTypeString };
        assert_eq!(
            board.stringForType(string_type).map(|s| s.to_string()),
            Some("cubelite-pasteboard-check".to_string())
        );
        assert!(board
            .stringForType(ns_string!("org.nspasteboard.ConcealedType"))
            .is_some());
        board.clearContents();
    }
}
