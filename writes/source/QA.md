# Writes preview QA inventory

## Claims and checks

- Private library: backend ownership tests cover list, single work, history, exports, and import jobs. Preview workspaces derive from the private proxy visitor identifier.
- Poetry preservation: exact whitespace round-trip test; browser create, edit, save, reopen, and view as a book.
- Portable files: JSON round-trip unit test; browser ZIP download, inspect TXT, HTML, JSON, and original source.
- Safe imports: review before commit, rights confirmation, unchanged duplicate skip, changed-post approval, revision retention, private-address blocking, inert HTML, bounded ZIP expansion.
- Sharing: confirmed snapshot, no source/history exposure, no automatic draft updates, revoke. Preview links are not public production links.
- Flipbook: cover, next/previous, keyboard arrows, scroll/book toggle, long-line wrapping toggle, long-page internal scrolling, desktop spread and mobile page.
- Editor: save, page break, title/author/type/collection/theme, history restore-as-draft, archive/restore, original view, dirty-navigation confirmation.
- Library: filters, search/clear, create, open book/editor, sources/manual refresh, export library, empty states.
- Presentation: desktop 1280+, mobile 375px, dark/light cycle, import and share dialogs, focus/Escape, no accidental document horizontal overflow.

## Off-happy-path checks

- Two editors save different versions: stale update must fail without losing the newer text.
- Same feed changes while a local draft has edits: replacement needs explicit review and retains both the imported original and local prior version.
- Remote import targets a private IP or compressed archive expands beyond the limit: reject before importing.
- Malicious HTML or archive metadata cannot create executable app HTML, foreign ownership, or imported public links.

## Scope exclusions

Production AWS provisioning, live member login, public distribution, scheduled sync, AI, media archiving, rich-text fidelity, and password-system modernization are not signed off by preview tests.

## Recorded results

- Twelve backend tests passed.
- Real feed parser checks: Substack test feed returned 20 entries; Medium test feed returned 10. No third-party articles were committed.
- Desktop QA at 1440 × 1000: library, editor, reader, import review, snapshot review, and dark mode inspected.
- Mobile QA at 375 × 812: library, single-page reader, editor, and import review inspected. Cramped editor settings were corrected to a single-column layout.
- Saved text, restored text, imported original, and downloaded TXT matched their expected strings, including indentation and stanza spacing.
- Downloaded ZIP included readable HTML, Markdown, JSON, original-source support, and revision files; the tested writing archive contained seven revision files.
- Browser snapshot test confirmed a later private edit was absent from the shared copy. Link revocation and backend access denial tests passed.
- Mobile file import survived page reload; canceling an unsaved-navigation confirmation preserved the draft.
- No JavaScript errors or unintended document-level horizontal overflow occurred in the completed desktop/mobile flows.
- Production dependency audit reported zero vulnerabilities at build time.
- AWS template locally checked with cfn-lint; no live CloudFormation stack was created.
# Poetry and preservation extension

QA inventory for this pass:
- Arrange verse: move up/down and back; indent/outdent; join lines; edit; undo/reset; cancel; apply to draft; save as an alternate; original remains unchanged.
- Named versions: named save; ordinary save; history label and restore; older named editions beyond 20 revisions; modal errors remain visible.
- Layout: manual/stanza page arrangement; left/center/right alignment; close/natural/open leading; original/compact/airy stanza gaps. Verify text remains unchanged and layout appears in reader and exports.
- Google text workflow: disconnected status; paste and TXT upload; document-address validation; duplicate skip; changed-source comparison; consent required; prior local edits preserved.
- Ownership and snapshots: no cross-owner history/fork; stale fork rejection; private metadata excluded; layout included in intended snapshot.
- Desktop/mobile/light/dark visual pass: editor, arranger, named-history modal, book reader, import review. Check horizontal overflow, legibility, control sizes, and scroll reachability.
- Off-happy-path: blank/CRLF/indented stanzas, invalid Doc address, and an import refresh after local editing/archiving.

Live Google-account import is intentionally excluded: authorization was dismissed. Live AWS deployment is also excluded; no production resources changed.

Extension verification, September 23, 2026:
- All 19 automated tests passed, including CRLF/indentation round-trips, older named-version retrieval, fork ownership and stale-version rejection, presentation-only layout, and reviewed Google-text refresh.
- Desktop browser controls passed the verse-arrangement, named-save/restore, alternate-copy, layout, reader-navigation, and light/dark cycles.
- A synthetic Google Doc identifier was used with pasted and uploaded test text. The invalid-address error, consent gate, replacement review, and restoration of a local draft all passed. No private Google document was fetched.
- The downloaded ZIP contained exact current TXT, readable HTML, JSON layout, captured source text, and three prior revisions.
- At 375 × 812, the editor, arranger, and reader had no unintended horizontal overflow. Modal controls remained reachable by scrolling. At 1440 × 1000, layout and history remained legible; no browser page errors were observed.
- The first stanza-per-page test caught extra boundary newlines around page markers. This was corrected in presentation only, without changing stored manuscript text.
