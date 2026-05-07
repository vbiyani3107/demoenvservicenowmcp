# ServiceNow Docs Search

Demo Env ServiceNow MCP can search and retrieve the official ServiceNowDocs markdown repository without depending on QMD or any user-local index.

## Modes

- **Live GitHub mode:** zero setup for family discovery and direct document fetches from `ServiceNow/ServiceNowDocs`.
- **Local sync mode:** optional SQLite FTS5 index for fast local search and offline use. Disabled by default.
- **Vector mode:** optional semantic search using sqlite-vec with deterministic local embeddings. It is disabled by default and requires local indexing.

## Configuration

```bash
HAPPY_DOCS_ENABLE_LOCAL_INDEX=false
HAPPY_DOCS_CACHE_DIR=~/.demoenvservicenowmcp/docs/servicenow
HAPPY_DOCS_ENABLE_VECTOR=false
HAPPY_DOCS_EMBEDDING_PROVIDER=none  # use local to enable deterministic local embeddings
HAPPY_MCP_DOCS_ONLY=false
GITHUB_TOKEN=optional-token-for-higher-rate-limits
```

The same system properties can live in `config/servicenow-instances.json`:

```json
{
  "docs": {
    "localIndexEnabled": false,
    "cacheDir": "~/.demoenvservicenowmcp/docs/servicenow",
    "enableVector": false,
    "embeddingProvider": "none"
  },
  "instances": []
}
```

`better-sqlite3` and `sqlite-vec` are optional npm dependencies. Live GitHub docs tools do not require them. Local sync/search requires `better-sqlite3` and `localIndexEnabled=true`. Vector search additionally requires `enableVector=true` and `embeddingProvider=local`; when sqlite-vec is unavailable, status reports the reason and FTS search continues to work.

Set `HAPPY_MCP_DOCS_ONLY=true` to expose only `SN-Docs-*` tools without ServiceNow credentials. The stdio server also falls back to docs-only mode when neither a ServiceNow config file nor ServiceNow environment credentials are present.

## Tools

- `SN-Docs-Families` - List available ServiceNowDocs families/releases.
- `SN-Docs-Status` - Show local cache, FTS, and vector status.
- `SN-Docs-Sync` - Download and index a docs family locally.
- `SN-Docs-Search` - Search the locally synced SQLite FTS index.
- `SN-Docs-Get` - Retrieve a markdown document from local cache or GitHub.

## Sync Example

```javascript
SN-Docs-Families({})
// Enable local indexing first: docs.localIndexEnabled=true or HAPPY_DOCS_ENABLE_LOCAL_INDEX=true
SN-Docs-Sync({ "family": "australia" })
SN-Docs-Search({ "query": "create a Flow Designer action", "family": "australia" })
SN-Docs-Get({ "family": "australia", "path": "platform/some-page.md" })
```

## Notes

- Docs sync does not use ServiceNow instance credentials.
- Docs tools default to the `australia` family because the upstream ServiceNowDocs repository does not currently expose a `latest` branch.
- Docs sync skips broken markdown links, reports `documentsSkipped`, and continues as long as at least one document syncs successfully.
- Search is local-first once a family has been synced.
- If a family is not synced, `SN-Docs-Search` returns a setup hint instead of failing hard.
- `SN-Docs-Get` falls back to GitHub raw markdown when a document is not in the local cache.
