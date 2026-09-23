# Social Desk Club Writes

Private member writing library for Social Desk Club. Source, tests, CloudFormation template, and a rebuilt AWS release candidate live in this folder.

## Local development

```bash
cd writes/source
npm ci
npm test
npm run build          # preview frontend → dist/public
node script/package.mjs  # production release → release/
```

Nineteen automated tests cover ownership isolation, poetry preservation, imports, snapshots, and Google Docs paste-only matching.

## Production layout

| Path | Purpose |
| --- | --- |
| `source/` | Editable app (client, server, shared, tests) |
| `frontend/` | Four public assets ready for `s3://socialdeskclub.com/writes/` |
| `writes-api.zip` | Lambda package (`index.handler`) |
| `writes-stack.yaml` | Isolated stack: DynamoDB library, Lambda, HTTP API, logs |
| `homepage/` | Proposed homepage card + baseline snapshot |
| `ARTIFACT_HASHES.txt` | SHA-256 of deployable frontend + API zip |

`frontend/config.js` still contains `REPLACE_WITH_WRITES_API_ENDPOINT` until the stack outputs are known.

## UX improvements in this PR

- Session restore via `sessionStorage` + `/api/bootstrap` (production no longer forces re-login on every refresh)
- Sign out
- Camp link beside Reads in the top nav
- Library capacity meter (500 writings first-release limit)
- Clearer Google Docs paste-only labeling (no live fetch implied)
- Theme preference persistence
- Skip link + setup health notice on the sign-in screen
- Production-aware copy in “The Writes promise”

## AWS deploy status

This environment has **no AWS credentials**. Per the handoff, stop at **Approval A** before any CloudFormation or S3 mutation.

Expected live test URL after Approval A deploy: `https://socialdeskclub.com/writes/index.html`

See `DEPLOY.md` and the Project plan for the Approval A/B sequence and CloudShell commands.
