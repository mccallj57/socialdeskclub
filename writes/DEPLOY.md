# Social Desk Club Writes

Writes is a working, isolated preview plus an AWS deployment candidate. It has not been installed on the live Social Desk Club site, and no AWS resources or permissions were changed.

## What works in the preview

- **Personal library:** Create and edit poems, stories, essays, and other writing. Use collections, search, category shelves, and archive/restore.
- **Imports:** Review Medium/Substack/RSS feed entries, pasted text, TXT, Markdown, HTML, Writes JSON, or ZIP archives before saving. Only import writing you own or have permission to copy.
- **Poetry editing:** Plain text preserves entered line breaks, indentation, and stanza spacing. A standalone `[[page]]` marks a deliberate page turn.
- **Verse arranging:** Move stanzas up/down, edit or indent individual blocks, join lines, undo/reset, and review the result. Apply to the unsaved manuscript or save an independent private alternate. Blank-line separators remain in their original positions during reordering.
- **Book layout:** Alignment, line spacing, stanza spacing, and one-stanza-per-page presentation are stored separately from the manuscript. Layout travels with versions, snapshots, and readable HTML exports; TXT remains unchanged.
- **Named versions:** Save text and layout under a label such as “Reading-night version.” The current version, 20 recent revisions, and older named revisions are available in history. Loading one creates an unsaved draft for review.
- **Google Docs drafts:** A dedicated import tab accepts pasted text or a TXT export plus the document address. Re-importing with the same address previews changes against the current Writes draft; replacement requires approval and retains the previous draft and captured source text in revision history.
- **Flipbooks:** Four cover styles, desktop spreads, single-page mobile reading, keyboard navigation, scroll reading, and optional long-line wrapping. Long pages scroll instead of dropping text.
- **Preservation:** Imported source text is stored separately. Re-importing an unchanged feed skips duplicates; changed feed posts require approval before replacing text. Prior versions remain available.
- **Exports:** ZIP download containing TXT, Markdown, readable offline HTML, structured JSON, original source text when available, and saved revisions.
- **Sharing:** Deliberate snapshots, not automatically updating live drafts. A snapshot includes the complete reviewed text, title, author, collection, and cover. Revocation disables the link but cannot recall copies recipients already made.

Preview workspaces are separated by the private Computer preview's visitor identity. Preview hosting is development infrastructure, not a permanent manuscript archive. Export important writing; the preview is not backed by your production AWS account.

## Important limits

- **Text only:** Images, audio, video, illustration uploads, AI illustration, and AI assistance are not implemented. There is no AI detector.
- **RSS is not a full backup:** Feeds can contain only recent posts or excerpts. Imported HTML becomes plain text and may not retain visual formatting; review poems before saving. Paywalls are not bypassed.
- **Manual refresh:** Saved publication sources have a review-new-posts action. There is no scheduled synchronization or write-back to Medium/Substack.
- **Import sizes:** Up to 40 writings per import; uploaded files/ZIPs up to 3 MB; ZIP expanded content up to 12 MB. Each writing allows 120 KB of text and up to 160 KB of original source, subject to a combined stored-size guard.
- **Library size:** First-release limit of 500 writings per member. The UI displays the current version, latest 20 saved revisions, and older named revisions; exports retrieve all retained revisions individually.
- **No live Google connection:** Google Drive authorization was dismissed. No connector-backed access or Google write-back is installed. A Doc URL only identifies the draft; it does not grant access or fetch content. Google comments, images, formatting, and pre-import Google revision history are not archived. Production direct importing needs separately authorized, per-member Google access; never use one person's preview connector as a shared member integration.
- **Backup restore:** Importing a Writes ZIP/JSON restores current writing and metadata as new private copies. Earlier revisions remain in the ZIP; this release does not rebuild the old revision timeline automatically.
- **Preview sharing:** The preview itself is private. Its snapshot links test the workflow but are not public production links.
- **Production authentication:** Designed to recognize the existing Reads member accounts. Members sign in to Writes separately; this is not automatic cross-tab single sign-on. The existing Reads password system is unchanged.

Medium documents its profile and publication RSS formats in [Using RSS feeds](https://help.medium.com/hc/en-us/articles/214874118-Using-RSS-feeds-of-profiles-publications-and-topics). Substack documents publication feeds at `/feed` in [its RSS guide](https://support.substack.com/hc/en-us/articles/360038239391-Is-there-an-RSS-feed-for-my-publication), and its full-post export workflow in [How do I export my posts?](https://support.substack.com/hc/en-us/articles/360037466012-How-do-I-export-my-posts).

## Proposed production boundary

The candidate stack creates a new Lambda, HTTP API, DynamoDB writing library, a narrowly scoped Lambda role, and a 14-day log group. It enables DynamoDB point-in-time recovery and retains the library if the stack is deleted.

The new role can read existing sessions and member records from `reads-users` with `GetItem` only. It has no write permission to Reads data and no permission at all to `reads-books`. Manuscripts live in the new encrypted DynamoDB table, never in the public frontend bucket.

Static frontend files go under `s3://socialdeskclub.com/writes/`. One reviewed change to the homepage adds a Writes project card beside Reads and Camp. The candidate does not replace or modify the Reads or Camp applications.

New AWS resources, API traffic, storage, backups, and logs can incur charges. None have been provisioned yet. The production adapter and CloudFormation template are release candidates: live account sign-in, IAM behavior, API routing, CORS, and CloudFront must pass the checks below before enabling the homepage entry.

## Files in the deployment package

- `frontend/`: Four public assets: `index.html`, `app.js`, `app.css`, and `config.js`.
- `writes-api.zip`: Bundled Lambda code; handler `index.handler`.
- `writes-stack.yaml`: Isolated infrastructure template.
- `writes-static-permission.json`: Optional narrowly scoped frontend-upload policy.
- `homepage/index.html`: Proposed homepage with a Writes card.
- `homepage/index-before-writes.html`: Read-only copy of the homepage retrieved on September 23, 2026. Verify it still matches the live homepage before uploading the proposed replacement.
- `source/`: Editable app source, lockfile, tests, and build scripts.

## Safe deployment sequence

Use an authorized AWS account administrator in `us-west-2`. Keep the current `readsdeeds` policy intact; do not replace it with a broad S3 or administrator grant.

### Create the isolated stack

Upload the package to AWS CloudShell and unzip it. From the package directory:

```bash
aws cloudformation deploy \
  --region us-west-2 \
  --stack-name socialdeskclub-writes \
  --template-file writes-stack.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ExistingUsersTable=reads-users
```

The template initially installs a harmless setup response. Upload the real Lambda code before exposing the tab:

```bash
aws lambda update-function-code \
  --region us-west-2 \
  --function-name socialdeskclub-writes-api \
  --zip-file fileb://writes-api.zip

aws lambda wait function-updated \
  --region us-west-2 \
  --function-name socialdeskclub-writes-api

aws cloudformation describe-stacks \
  --region us-west-2 \
  --stack-name socialdeskclub-writes \
  --query 'Stacks[0].Outputs' \
  --output table
```

CloudFormation keeps its setup placeholder in the template; later infrastructure updates must preserve the deployed code or deliberately redeploy `writes-api.zip`. Do not change the inline setup code expecting it to represent the current application release.

### Configure and upload Writes only

Replace `REPLACE_WITH_WRITES_API_ENDPOINT` in `frontend/config.js` with the stack's `WritesApiEndpoint`, with no trailing slash. Keep `authBase` pointing to the existing Reads API.

Upload exact files with correct content types and short/no-cache behavior:

```bash
aws s3 cp frontend/index.html s3://socialdeskclub.com/writes/index.html \
  --content-type text/html --cache-control no-cache
aws s3 cp frontend/app.js s3://socialdeskclub.com/writes/app.js \
  --content-type application/javascript --cache-control no-cache
aws s3 cp frontend/app.css s3://socialdeskclub.com/writes/app.css \
  --content-type text/css --cache-control no-cache
aws s3 cp frontend/config.js s3://socialdeskclub.com/writes/config.js \
  --content-type application/javascript --cache-control no-store
```

The current narrowly scoped `readsdeeds` permission does not cover these paths or the homepage. If Computer will upload the files later, an administrator may add the separately supplied exact-path policy after reviewing it. Do not grant wildcard bucket writes, public manuscript access, or broad Lambda permissions.

### Verify before adding the homepage entry

Open `https://socialdeskclub.com/writes/index.html` through the site's current access controls.

1. Confirm `/api/health` reports production and no preview/example workspace is created.
2. Sign in with two distinct authorized Reads accounts. Create test writing in each and verify isolation, including guessed work IDs, revisions, import jobs, and exports.
3. Import an owned feed or file. Verify duplicates, manual changed-post review, and original text.
4. Save a poem containing indentation and stanza breaks; read both pages on desktop and mobile.
5. Export and inspect TXT, JSON, HTML, original source, and revisions.
6. Share a test snapshot. Edit the private draft and verify the shared text does not change. Revoke the link and verify it stops loading.
7. Verify unpublished writing endpoints reject unauthenticated requests. Check production logs contain no manuscript text, passwords, or tokens.
8. Confirm existing Reads and Camp still operate.

The current site uses CloudFront access controls. An unlisted Writes snapshot is not guaranteed to be publicly accessible outside those controls; do not weaken the site's authentication as part of this deployment.

Only after these checks, re-download and compare the live root homepage with `homepage/index-before-writes.html`. If it changed, reapply only the Writes card to the latest version rather than replacing unrelated changes.

```bash
aws s3 cp homepage/index.html s3://socialdeskclub.com/index.html \
  --content-type text/html --cache-control no-cache
```

Invalidate the exact root and Writes paths in the correct existing CloudFront distribution, if required. The distribution ID is deliberately not guessed, and no broad invalidation or distribution-policy change has been prepared.

## Rollback

Remove the Writes homepage card by restoring the verified prior homepage. This hides the new section without touching Reads or Camp. Keep the Writes table and backups intact; do not delete writing to roll back a frontend release.

Keep copies of the previous Lambda ZIP and frontend assets for later version rollbacks. If disabling Writes entirely, first export member writing and take a backup; a shutdown/deletion is a separate, confirmed operation.

## Verification completed

Twelve automated backend tests passed, covering ownership isolation, exact text preservation, optimistic concurrency, atomic saves, snapshots/revocation, feed deduplication and changed-source review, expiring import jobs, public-address validation, inert HTML, ZIP limits, and safe backup import.

Browser checks covered desktop and 375-pixel mobile library/editor/reader, save/reload persistence, page breaks, page turns, scroll mode, wrapping, version restore, archive/restore, file/paste import, ownership confirmation, source-original view, download content, snapshot isolation, dark/light mode, and unsaved-navigation protection. No browser JavaScript errors were observed during those flows.

The application import code also successfully read the public Medium and Substack test feeds without importing their posts into a member library. This verifies those tested feeds, not a guarantee that every publication permits RSS access.
