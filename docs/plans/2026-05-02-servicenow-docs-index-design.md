# ServiceNow Docs Index Design

## Goal

Add an optional ServiceNow documentation capability to Demo Env ServiceNow MCP that can search and retrieve the official ServiceNowDocs markdown corpus without depending on QMD or any user-local index.

## Context

ServiceNow now publishes documentation in markdown through `ServiceNow/ServiceNowDocs`. The repository is a better source for AI retrieval than the JavaScript-driven public docs site because agents can fetch branch-specific markdown directly from GitHub.

Demo Env ServiceNow MCP should use that repository as the source of truth while keeping local storage optional. The product must work in npm and Docker MCP Registry installs without requiring users to pre-download thousands of files or run a separate vector database.

## Architecture

The docs layer has three progressive modes:

1. **Live GitHub mode** is the default. It fetches `llms.txt`, discovers available doc families, and retrieves known markdown files from GitHub raw URLs. This supports zero-setup `SN-Docs-Families` and `SN-Docs-Get`, plus lightweight search where practical.
2. **Local sync mode** is optional. `SN-Docs-Sync` downloads selected doc families into a cache directory and builds a SQLite index. SQLite FTS5 provides fast keyword search and offline use.
3. **Vector mode** is optional. If enabled, the server chunks docs, embeds chunks, and stores vectors with sqlite-vec. Search can then run hybrid keyword plus semantic retrieval.

GitHub remains the source of truth. Local indexes are disposable caches that can be rebuilt at any time.

## Components

- `src/docs/github-client.js`: fetches `llms.txt`, branch manifests, and raw markdown from `ServiceNow/ServiceNowDocs`.
- `src/docs/cache.js`: resolves cache paths, stores downloaded markdown, records source metadata, and avoids writing outside the configured cache directory.
- `src/docs/indexer.js`: chunks markdown and builds or updates the SQLite FTS5 index.
- `src/docs/search.js`: runs keyword search by default and hybrid search when vector mode is enabled.
- `src/docs/vector-index.js`: optional sqlite-vec integration and embedding storage.
- `src/docs/tools.js`: registers docs MCP tools with the existing consolidated server.

## MCP Surface

Initial tools:

- `SN-Docs-Families`: list available doc families/releases from ServiceNowDocs.
- `SN-Docs-Status`: report cache location, synced families, index freshness, FTS availability, and vector availability.
- `SN-Docs-Sync`: download or refresh a selected family, then build the local FTS index.
- `SN-Docs-Search`: search docs by query, family, product area, and result limit.
- `SN-Docs-Get`: retrieve a markdown document or chunk by path/doc id.

Later tools:

- `SN-Docs-Answer`: compose an answer from retrieved docs with citations.
- `SN-Docs-Explain-With-Context`: combine live ServiceNow schema/API data with relevant official docs.

## Storage

Default cache path:

```text
~/.demoenvservicenowmcp/docs/servicenow/
```

Configurable with:

```text
HAPPY_DOCS_CACHE_DIR
HAPPY_DOCS_ENABLE_VECTOR=true|false
HAPPY_DOCS_EMBEDDING_PROVIDER=none|openai|local
```

SQLite database:

```text
~/.demoenvservicenowmcp/docs/servicenow/index.sqlite
```

Minimum tables:

- `families`: release family metadata and source commit/etag.
- `documents`: one row per markdown document.
- `chunks`: searchable chunks with path, title, headings, product area, line range, and body.
- `chunks_fts`: FTS5 virtual table for keyword search.
- `embeddings`: optional vector rows keyed to chunks.

## Data Flow

`SN-Docs-Families` fetches and caches release metadata from GitHub. `SN-Docs-Sync` downloads markdown for a selected family, chunks documents by headings and size, writes documents/chunks to SQLite, and refreshes FTS rows in one transaction.

`SN-Docs-Search` prefers local FTS when an index exists. If the family is not synced, it returns an actionable message explaining that live fetch can retrieve known docs, but sync is needed for full local search. If vector mode is enabled and ready, the search layer combines FTS and vector results with a simple reciprocal-rank fusion.

`SN-Docs-Get` can read from local cache first, then fall back to GitHub raw content for known paths.

## Error Handling

- GitHub rate limits return clear retry guidance and mention optional `GITHUB_TOKEN`.
- Missing local index returns a non-fatal setup hint: run `SN-Docs-Sync`.
- sqlite-vec unavailable does not break FTS search. It only disables vector mode.
- Embedding configuration errors disable vector indexing and surface through `SN-Docs-Status`.
- Sync failures preserve the previous successful index and write new state only after a successful transaction.

## Security

- Sync writes only inside the configured cache directory.
- Paths from GitHub or tool input are normalized and rejected if they attempt traversal.
- No ServiceNow credentials are used for docs sync.
- GitHub token is optional and treated as a secret if provided.
- Vectorization is opt-in because it can send doc chunks to an embedding provider.

## Testing

- Unit tests for GitHub URL/path construction, cache path safety, markdown chunking, SQLite schema creation, FTS search ranking, and tool input validation.
- Integration tests with a tiny fixture docs repository or mocked GitHub responses.
- Optional vector tests are skipped unless sqlite-vec and an embedding stub are available.
- Existing MCP tool listing tests should confirm the docs tools appear and remain optional.

## Open Decisions

- Whether to use `better-sqlite3`, `sqlite3`, or Node's built-in SQLite support if the target Node version supports the needed APIs.
- Which sqlite-vec npm package is most reliable across Docker and local npm installs.
- Whether first release should include vector indexing behind a flag or ship FTS first and add sqlite-vec in a follow-up.

