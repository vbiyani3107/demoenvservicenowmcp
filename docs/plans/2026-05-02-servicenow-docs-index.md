# ServiceNow Docs Index Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add optional ServiceNowDocs search and retrieval tools backed by live GitHub fetches, local SQLite FTS5 sync, and an optional sqlite-vec vector layer.

**Architecture:** The docs feature is a self-contained `src/docs/` module. It defaults to live GitHub metadata/document fetches, can sync selected ServiceNowDocs families into a local cache, and uses SQLite FTS5 for product-grade local search. Vectorization is opt-in and layered behind a capability check so missing sqlite-vec never breaks baseline docs search.

**Tech Stack:** Node.js ESM, MCP SDK request handlers, SQLite FTS5, optional sqlite-vec, Jest, mocked GitHub HTTP responses, local filesystem cache under `~/.demoenvservicenowmcp/docs/servicenow`.

---

### Task 1: Add Docs Configuration and Cache Path Helpers

**Files:**
- Create: `src/docs/config.js`
- Create: `tests/docs-config.test.js`

**Step 1: Write the failing tests**

Create `tests/docs-config.test.js`:

```js
import os from 'os';
import path from 'path';
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import {
  getDocsConfig,
  resolveDocsCachePath,
  normalizeSafeRelativePath
} from '../src/docs/config.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('docs config', () => {
  test('uses the default cache directory under the user home', () => {
    delete process.env.HAPPY_DOCS_CACHE_DIR;
    const config = getDocsConfig();
    expect(config.cacheDir).toBe(path.join(os.homedir(), '.demoenvservicenowmcp', 'docs', 'servicenow'));
    expect(config.enableVector).toBe(false);
  });

  test('allows cache directory and vector flag through env vars', () => {
    process.env.HAPPY_DOCS_CACHE_DIR = '/tmp/happy-docs';
    process.env.HAPPY_DOCS_ENABLE_VECTOR = 'true';
    const config = getDocsConfig();
    expect(config.cacheDir).toBe('/tmp/happy-docs');
    expect(config.enableVector).toBe(true);
  });

  test('rejects path traversal for relative docs paths', () => {
    expect(() => normalizeSafeRelativePath('../secret.md')).toThrow(/Unsafe docs path/);
    expect(() => normalizeSafeRelativePath('/absolute.md')).toThrow(/Unsafe docs path/);
    expect(normalizeSafeRelativePath('docs/platform/foo.md')).toBe('docs/platform/foo.md');
  });

  test('resolves safe cache paths inside the cache directory', () => {
    const fullPath = resolveDocsCachePath('/tmp/cache', 'australia/foo/bar.md');
    expect(fullPath).toBe(path.join('/tmp/cache', 'australia/foo/bar.md'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/docs-config.test.js`

Expected: FAIL because `src/docs/config.js` does not exist.

**Step 3: Implement config helpers**

Create `src/docs/config.js`:

```js
import os from 'os';
import path from 'path';

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.demoenvservicenowmcp', 'docs', 'servicenow');

export function getDocsConfig(env = process.env) {
  return {
    cacheDir: env.HAPPY_DOCS_CACHE_DIR || DEFAULT_CACHE_DIR,
    enableVector: env.HAPPY_DOCS_ENABLE_VECTOR === 'true',
    embeddingProvider: env.HAPPY_DOCS_EMBEDDING_PROVIDER || 'none',
    githubToken: env.GITHUB_TOKEN || ''
  };
}

export function normalizeSafeRelativePath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('Unsafe docs path: path is required');
  }

  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
  if (normalized.startsWith('../') || normalized === '..' || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe docs path: ${relativePath}`);
  }

  return normalized;
}

export function resolveDocsCachePath(cacheDir, relativePath) {
  const safePath = normalizeSafeRelativePath(relativePath);
  const resolved = path.resolve(cacheDir, safePath);
  const root = path.resolve(cacheDir);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Unsafe docs path: ${relativePath}`);
  }

  return resolved;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/docs-config.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/docs/config.js tests/docs-config.test.js
git commit -m "feat: add docs cache configuration"
```

### Task 2: Add ServiceNowDocs GitHub Client

**Files:**
- Create: `src/docs/github-client.js`
- Create: `tests/docs-github-client.test.js`

**Step 1: Write the failing tests**

Create `tests/docs-github-client.test.js`:

```js
import { describe, expect, jest, test } from '@jest/globals';
import {
  createServiceNowDocsClient,
  parseFamiliesFromLlms
} from '../src/docs/github-client.js';

describe('ServiceNowDocs GitHub client', () => {
  test('parses family links from llms.txt markdown', () => {
    const families = parseFamiliesFromLlms(`
# ServiceNow Docs
- [latest](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/latest/llms.txt)
- [australia](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/llms.txt)
`);

    expect(families).toEqual([
      { name: 'latest', branch: 'latest' },
      { name: 'australia', branch: 'australia' }
    ]);
  });

  test('fetches llms.txt with optional GitHub token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => '- [latest](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/latest/llms.txt)'
    });
    const client = createServiceNowDocsClient({ fetchImpl: fetchMock, githubToken: 'token' });

    const families = await client.listFamilies();

    expect(families).toEqual([{ name: 'latest', branch: 'latest' }]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token');
  });

  test('returns actionable errors for GitHub failures', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'rate limited',
      text: async () => 'rate limit'
    });
    const client = createServiceNowDocsClient({ fetchImpl: fetchMock });

    await expect(client.listFamilies()).rejects.toThrow(/GitHub request failed.*403/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/docs-github-client.test.js`

Expected: FAIL because `src/docs/github-client.js` does not exist.

**Step 3: Implement GitHub client**

Create `src/docs/github-client.js`:

```js
const OWNER = 'ServiceNow';
const REPO = 'ServiceNowDocs';
const DEFAULT_BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}`;

function authHeaders(githubToken) {
  return githubToken ? { Authorization: `Bearer ${githubToken}` } : {};
}

async function fetchText(fetchImpl, url, githubToken) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'text/plain',
      ...authHeaders(githubToken)
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub request failed (${response.status} ${response.statusText}) for ${url}. ${body}`.trim());
  }

  return response.text();
}

export function parseFamiliesFromLlms(text) {
  const families = [];
  const seen = new Set();
  const linkPattern = /\[([^\]]+)\]\(https:\/\/raw\.githubusercontent\.com\/ServiceNow\/ServiceNowDocs\/([^/)]+)\/llms\.txt\)/g;

  for (const match of text.matchAll(linkPattern)) {
    const name = match[1].trim();
    const branch = match[2].trim();
    if (!seen.has(branch)) {
      seen.add(branch);
      families.push({ name, branch });
    }
  }

  return families;
}

export function createServiceNowDocsClient({
  fetchImpl = globalThis.fetch,
  githubToken = ''
} = {}) {
  if (!fetchImpl) {
    throw new Error('Fetch API is unavailable in this Node runtime');
  }

  return {
    async listFamilies() {
      const text = await fetchText(fetchImpl, `${RAW_BASE}/${DEFAULT_BRANCH}/llms.txt`, githubToken);
      return parseFamiliesFromLlms(text);
    },

    async getLlms(branch) {
      return fetchText(fetchImpl, `${RAW_BASE}/${branch}/llms.txt`, githubToken);
    },

    async getMarkdown(branch, relativePath) {
      const safePath = relativePath.replace(/^\/+/, '');
      return fetchText(fetchImpl, `${RAW_BASE}/${branch}/${safePath}`, githubToken);
    }
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/docs-github-client.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/docs/github-client.js tests/docs-github-client.test.js
git commit -m "feat: add ServiceNowDocs GitHub client"
```

### Task 3: Add Markdown Chunking

**Files:**
- Create: `src/docs/chunker.js`
- Create: `tests/docs-chunker.test.js`

**Step 1: Write the failing tests**

Create `tests/docs-chunker.test.js`:

```js
import { describe, expect, test } from '@jest/globals';
import { chunkMarkdown } from '../src/docs/chunker.js';

describe('chunkMarkdown', () => {
  test('chunks markdown by headings with metadata', () => {
    const chunks = chunkMarkdown({
      family: 'australia',
      path: 'platform/admin/example.md',
      markdown: '# Page Title\n\nIntro.\n\n## First\n\nBody one.\n\n## Second\n\nBody two.'
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      family: 'australia',
      path: 'platform/admin/example.md',
      title: 'Page Title',
      heading: 'Page Title'
    });
    expect(chunks[1].heading).toBe('First');
    expect(chunks[2].body).toContain('Body two.');
  });

  test('keeps line ranges for citations', () => {
    const chunks = chunkMarkdown({
      family: 'latest',
      path: 'foo.md',
      markdown: '# Title\n\nLine 3\n\n## Details\n\nLine 7'
    });

    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(4);
    expect(chunks[1].startLine).toBe(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/docs-chunker.test.js`

Expected: FAIL because `src/docs/chunker.js` does not exist.

**Step 3: Implement chunker**

Create `src/docs/chunker.js`:

```js
function headingText(line) {
  const match = line.match(/^#{1,6}\s+(.+)$/);
  return match ? match[1].trim() : null;
}

export function chunkMarkdown({ family, path, markdown }) {
  const lines = markdown.split(/\r?\n/);
  const title = lines.map(headingText).find(Boolean) || path;
  const chunks = [];
  let current = null;

  function flush(endLine) {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (body) {
      chunks.push({
        family,
        path,
        title,
        heading: current.heading,
        startLine: current.startLine,
        endLine,
        body
      });
    }
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const heading = headingText(line);
    if (heading) {
      flush(lineNumber - 1);
      current = {
        heading,
        startLine: lineNumber,
        lines: [line]
      };
      return;
    }

    if (!current) {
      current = {
        heading: title,
        startLine: lineNumber,
        lines: []
      };
    }
    current.lines.push(line);
  });

  flush(lines.length);
  return chunks;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/docs-chunker.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/docs/chunker.js tests/docs-chunker.test.js
git commit -m "feat: chunk ServiceNow docs markdown"
```

### Task 4: Add SQLite FTS Store

**Files:**
- Create: `src/docs/sqlite-store.js`
- Create: `tests/docs-sqlite-store.test.js`
- Modify: `package.json`

**Step 1: Choose SQLite package**

Use `better-sqlite3` unless install/build compatibility fails in the target Node/Docker environment. It gives simple synchronous transactions and supports FTS5 in common builds.

Install:

```bash
npm install better-sqlite3
```

**Step 2: Write the failing tests**

Create `tests/docs-sqlite-store.test.js`:

```js
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, test, beforeEach } from '@jest/globals';
import { createDocsStore } from '../src/docs/sqlite-store.js';

let tempDir;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'happy-docs-'));
});

describe('docs sqlite store', () => {
  test('indexes and searches chunks with FTS5', async () => {
    const store = createDocsStore(path.join(tempDir, 'index.sqlite'));
    store.initialize();
    store.upsertFamily({ name: 'australia', branch: 'australia', syncedAt: '2026-05-02T00:00:00Z' });
    store.replaceDocument({
      family: 'australia',
      path: 'foo.md',
      sha: 'abc',
      title: 'Flow Designer',
      markdown: '# Flow Designer\n\nCreate actions.'
    }, [
      {
        family: 'australia',
        path: 'foo.md',
        title: 'Flow Designer',
        heading: 'Flow Designer',
        startLine: 1,
        endLine: 3,
        body: '# Flow Designer\n\nCreate actions.'
      }
    ]);

    const results = store.search({ query: 'create actions', family: 'australia', limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      family: 'australia',
      path: 'foo.md',
      title: 'Flow Designer'
    });
  });

  test('reports status', () => {
    const store = createDocsStore(path.join(tempDir, 'index.sqlite'));
    store.initialize();
    expect(store.status()).toMatchObject({ ftsAvailable: true, vectorAvailable: false });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test -- tests/docs-sqlite-store.test.js`

Expected: FAIL because `src/docs/sqlite-store.js` does not exist.

**Step 4: Implement SQLite store**

Create `src/docs/sqlite-store.js` with:

```js
import Database from 'better-sqlite3';

export function createDocsStore(dbPath) {
  const db = new Database(dbPath);

  return {
    initialize() {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS families (
          name TEXT PRIMARY KEY,
          branch TEXT NOT NULL,
          synced_at TEXT
        );
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          family TEXT NOT NULL,
          path TEXT NOT NULL,
          sha TEXT,
          title TEXT,
          markdown TEXT NOT NULL,
          UNIQUE(family, path)
        );
        CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id INTEGER NOT NULL,
          family TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT,
          heading TEXT,
          start_line INTEGER,
          end_line INTEGER,
          body TEXT NOT NULL,
          FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          title,
          heading,
          body,
          content='chunks',
          content_rowid='id'
        );
      `);
    },

    upsertFamily({ name, branch, syncedAt }) {
      db.prepare(`
        INSERT INTO families (name, branch, synced_at)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET branch=excluded.branch, synced_at=excluded.synced_at
      `).run(name, branch, syncedAt);
    },

    replaceDocument(document, chunks) {
      const tx = db.transaction(() => {
        const existing = db.prepare('SELECT id FROM documents WHERE family = ? AND path = ?').get(document.family, document.path);
        if (existing) {
          db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)').run(existing.id);
          db.prepare('DELETE FROM chunks WHERE document_id = ?').run(existing.id);
          db.prepare('UPDATE documents SET sha = ?, title = ?, markdown = ? WHERE id = ?')
            .run(document.sha, document.title, document.markdown, existing.id);
        } else {
          db.prepare('INSERT INTO documents (family, path, sha, title, markdown) VALUES (?, ?, ?, ?, ?)')
            .run(document.family, document.path, document.sha, document.title, document.markdown);
        }

        const row = db.prepare('SELECT id FROM documents WHERE family = ? AND path = ?').get(document.family, document.path);
        const insertChunk = db.prepare(`
          INSERT INTO chunks (document_id, family, path, title, heading, start_line, end_line, body)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, title, heading, body) VALUES (?, ?, ?, ?)');

        for (const chunk of chunks) {
          const result = insertChunk.run(row.id, chunk.family, chunk.path, chunk.title, chunk.heading, chunk.startLine, chunk.endLine, chunk.body);
          insertFts.run(result.lastInsertRowid, chunk.title, chunk.heading, chunk.body);
        }
      });

      tx();
    },

    search({ query, family, limit = 10 }) {
      return db.prepare(`
        SELECT c.id, c.family, c.path, c.title, c.heading, c.start_line AS startLine,
               c.end_line AS endLine, snippet(chunks_fts, 2, '<mark>', '</mark>', '...', 20) AS snippet
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
          AND (? IS NULL OR c.family = ?)
        ORDER BY rank
        LIMIT ?
      `).all(query, family || null, family || null, limit);
    },

    getDocument({ family, path }) {
      return db.prepare('SELECT family, path, title, markdown FROM documents WHERE family = ? AND path = ?').get(family, path);
    },

    status() {
      const families = db.prepare('SELECT name, branch, synced_at AS syncedAt FROM families ORDER BY name').all();
      return {
        dbPath,
        ftsAvailable: true,
        vectorAvailable: false,
        families
      };
    },

    close() {
      db.close();
    }
  };
}
```

**Step 5: Run test to verify it passes**

Run: `npm test -- tests/docs-sqlite-store.test.js`

Expected: PASS.

**Step 6: Commit**

```bash
git add package.json package-lock.json src/docs/sqlite-store.js tests/docs-sqlite-store.test.js
git commit -m "feat: add SQLite docs FTS store"
```

### Task 5: Add Docs Sync Service

**Files:**
- Create: `src/docs/sync.js`
- Create: `tests/docs-sync.test.js`

**Step 1: Write the failing tests**

Create `tests/docs-sync.test.js`:

```js
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, jest, test } from '@jest/globals';
import { syncDocsFamily } from '../src/docs/sync.js';

describe('syncDocsFamily', () => {
  test('downloads markdown paths from family llms and indexes them', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'happy-docs-sync-'));
    const client = {
      getLlms: jest.fn().mockResolvedValue('- [Flow Designer](platform/flow-designer.md)'),
      getMarkdown: jest.fn().mockResolvedValue('# Flow Designer\n\nCreate actions.')
    };

    const result = await syncDocsFamily({
      family: 'australia',
      branch: 'australia',
      cacheDir,
      client
    });

    expect(result.documentsSynced).toBe(1);
    expect(await fs.readFile(path.join(cacheDir, 'australia', 'platform', 'flow-designer.md'), 'utf8'))
      .toContain('Create actions');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/docs-sync.test.js`

Expected: FAIL because `src/docs/sync.js` does not exist.

**Step 3: Implement sync service**

Create `src/docs/sync.js`:

```js
import fs from 'fs/promises';
import path from 'path';
import { chunkMarkdown } from './chunker.js';
import { resolveDocsCachePath } from './config.js';
import { createDocsStore } from './sqlite-store.js';

export function parseMarkdownLinks(llmsText) {
  const links = [];
  const seen = new Set();
  const pattern = /\[[^\]]+\]\(([^)]+\.md)\)/g;
  for (const match of llmsText.matchAll(pattern)) {
    const link = match[1].replace(/^https:\/\/raw\.githubusercontent\.com\/ServiceNow\/ServiceNowDocs\/[^/]+\//, '');
    if (!seen.has(link)) {
      seen.add(link);
      links.push(link);
    }
  }
  return links;
}

export async function syncDocsFamily({ family, branch, cacheDir, client }) {
  const familyDir = resolveDocsCachePath(cacheDir, family);
  await fs.mkdir(familyDir, { recursive: true });

  const dbPath = path.join(cacheDir, 'index.sqlite');
  const store = createDocsStore(dbPath);
  store.initialize();

  const llms = await client.getLlms(branch);
  const links = parseMarkdownLinks(llms);
  store.upsertFamily({ name: family, branch, syncedAt: new Date().toISOString() });

  let documentsSynced = 0;
  for (const link of links) {
    const markdown = await client.getMarkdown(branch, link);
    const outputPath = resolveDocsCachePath(cacheDir, path.posix.join(family, link));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, markdown, 'utf8');

    const chunks = chunkMarkdown({ family, path: link, markdown });
    store.replaceDocument({
      family,
      path: link,
      sha: null,
      title: chunks[0]?.title || link,
      markdown
    }, chunks);
    documentsSynced += 1;
  }

  store.close();
  return { family, branch, documentsSynced };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/docs-sync.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/docs/sync.js tests/docs-sync.test.js
git commit -m "feat: sync ServiceNow docs locally"
```

### Task 6: Add Docs Tool Handlers

**Files:**
- Create: `src/docs/tool-definitions.js`
- Create: `src/docs/tool-handlers.js`
- Modify: `src/mcp-server-consolidated.js`
- Create: `tests/docs-tools.test.js`

**Step 1: Write the failing tests**

Create `tests/docs-tools.test.js`:

```js
import { describe, expect, test } from '@jest/globals';
import { docsToolDefinitions } from '../src/docs/tool-definitions.js';

describe('docs MCP tools', () => {
  test('defines initial docs tools', () => {
    expect(docsToolDefinitions.map((tool) => tool.name)).toEqual([
      'SN-Docs-Families',
      'SN-Docs-Status',
      'SN-Docs-Sync',
      'SN-Docs-Search',
      'SN-Docs-Get'
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/docs-tools.test.js`

Expected: FAIL because docs tool files do not exist.

**Step 3: Add tool definitions**

Create `src/docs/tool-definitions.js` with JSON-schema-style tool definitions for:

```js
export const docsToolDefinitions = [
  {
    name: 'SN-Docs-Families',
    description: 'List available ServiceNow documentation families/releases from the official ServiceNowDocs GitHub repository.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'SN-Docs-Status',
    description: 'Show local ServiceNow docs cache, FTS index, and optional vector index status.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'SN-Docs-Sync',
    description: 'Download and index a ServiceNowDocs family into the local SQLite FTS cache.',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', description: 'Docs family to sync, such as latest or australia.' },
        branch: { type: 'string', description: 'Optional GitHub branch. Defaults to the same value as family.' }
      },
      required: ['family']
    }
  },
  {
    name: 'SN-Docs-Search',
    description: 'Search locally synced ServiceNow documentation using SQLite FTS, with optional vector search when enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        family: { type: 'string', description: 'Optional docs family filter.' },
        limit: { type: 'number', description: 'Maximum results to return.', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'SN-Docs-Get',
    description: 'Retrieve a ServiceNow documentation markdown document by family and path.',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', description: 'Docs family, such as latest or australia.' },
        path: { type: 'string', description: 'Markdown path inside the docs family.' }
      },
      required: ['family', 'path']
    }
  }
];
```

**Step 4: Add handlers**

Create `src/docs/tool-handlers.js` with `handleDocsTool(name, args, deps)` that calls:

- `client.listFamilies()` for `SN-Docs-Families`
- `store.status()` for `SN-Docs-Status`
- `syncDocsFamily(...)` for `SN-Docs-Sync`
- `store.search(...)` for `SN-Docs-Search`
- `store.getDocument(...)` with GitHub fallback for `SN-Docs-Get`

Return MCP content blocks shaped as:

```js
return {
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
};
```

**Step 5: Wire tools into consolidated server**

Modify `src/mcp-server-consolidated.js`:

- Import `docsToolDefinitions` and `handleDocsTool`.
- Append `...docsToolDefinitions` to the existing `tools` array.
- In the `CallToolRequestSchema` handler, route names starting with `SN-Docs-` to `handleDocsTool`.

**Step 6: Run focused tests**

Run:

```bash
npm test -- tests/docs-tools.test.js tests/resources.test.js
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/docs/tool-definitions.js src/docs/tool-handlers.js src/mcp-server-consolidated.js tests/docs-tools.test.js
git commit -m "feat: expose ServiceNow docs MCP tools"
```

### Task 7: Add Optional sqlite-vec Vector Layer Stub

**Files:**
- Create: `src/docs/vector-index.js`
- Create: `tests/docs-vector-index.test.js`
- Modify: `src/docs/sqlite-store.js`
- Modify: `src/docs/tool-handlers.js`

**Step 1: Write the failing tests**

Create `tests/docs-vector-index.test.js`:

```js
import { describe, expect, test } from '@jest/globals';
import { createVectorIndex } from '../src/docs/vector-index.js';

describe('vector index', () => {
  test('is disabled when vector config is false', async () => {
    const index = createVectorIndex({ enableVector: false });
    expect(index.available).toBe(false);
    expect(await index.search()).toEqual([]);
  });

  test('reports missing embedding provider as unavailable', () => {
    const index = createVectorIndex({ enableVector: true, embeddingProvider: 'none' });
    expect(index.available).toBe(false);
    expect(index.reason).toMatch(/embedding provider/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/docs-vector-index.test.js`

Expected: FAIL because `src/docs/vector-index.js` does not exist.

**Step 3: Implement disabled vector adapter**

Create `src/docs/vector-index.js`:

```js
export function createVectorIndex({ enableVector, embeddingProvider }) {
  if (!enableVector) {
    return {
      available: false,
      reason: 'Vector search disabled',
      async indexChunks() {},
      async search() {
        return [];
      }
    };
  }

  if (!embeddingProvider || embeddingProvider === 'none') {
    return {
      available: false,
      reason: 'Vector search requires an embedding provider',
      async indexChunks() {},
      async search() {
        return [];
      }
    };
  }

  return {
    available: false,
    reason: 'sqlite-vec integration not installed yet',
    async indexChunks() {},
    async search() {
      return [];
    }
  };
}
```

**Step 4: Surface vector status**

Update `src/docs/sqlite-store.js` or `src/docs/tool-handlers.js` so `SN-Docs-Status` includes vector availability and reason.

**Step 5: Run test to verify it passes**

Run: `npm test -- tests/docs-vector-index.test.js`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/docs/vector-index.js src/docs/sqlite-store.js src/docs/tool-handlers.js tests/docs-vector-index.test.js
git commit -m "feat: add optional docs vector adapter"
```

### Task 8: Add Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/API_REFERENCE.md`
- Create: `docs/SERVICENOW_DOCS_SEARCH.md`

**Step 1: Document user workflow**

Create `docs/SERVICENOW_DOCS_SEARCH.md` with:

```markdown
# ServiceNow Docs Search

Demo Env ServiceNow MCP can search the official ServiceNowDocs markdown repository.

## Modes

- Live GitHub mode: zero setup for family discovery and direct document fetches.
- Local sync mode: optional SQLite FTS5 index for fast local search.
- Vector mode: optional semantic search when configured.

## Tools

- `SN-Docs-Families`
- `SN-Docs-Status`
- `SN-Docs-Sync`
- `SN-Docs-Search`
- `SN-Docs-Get`

## Sync Example

```javascript
SN-Docs-Sync({ "family": "latest" })
SN-Docs-Search({ "query": "create a Flow Designer action", "family": "latest" })
```
```

**Step 2: Update README and API reference**

Add a short feature section to `README.md` and tool entries to `docs/API_REFERENCE.md`.

**Step 3: Run docs grep**

Run:

```bash
rg "SN-Docs" README.md docs/API_REFERENCE.md docs/SERVICENOW_DOCS_SEARCH.md
```

Expected: all docs tool names appear.

**Step 4: Commit**

```bash
git add README.md docs/API_REFERENCE.md docs/SERVICENOW_DOCS_SEARCH.md
git commit -m "docs: document ServiceNow docs search"
```

### Task 9: Final Verification

**Files:**
- No new files unless fixes are needed.

**Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 2: Verify MCP tool list still loads without ServiceNow credentials**

Run:

```bash
node --input-type=module - <<'NODE'
import { createMcpServer } from './src/mcp-server-consolidated.js';
const client = { setProgressCallback() {} };
const server = await createMcpServer(client);
const handler = server._requestHandlers.get('tools/list');
const result = await handler({ method: 'tools/list', params: {} }, {});
console.log(result.tools.filter((tool) => tool.name.startsWith('SN-Docs-')).map((tool) => tool.name));
NODE
```

Expected: output includes all five `SN-Docs-*` tools.

**Step 3: Verify Docker build still works**

Run:

```bash
docker build -t demoenvservicenowmcp:docs-search .
```

Expected: image builds successfully.

**Step 4: Commit any fixes**

```bash
git status --short
git add <fixed-files>
git commit -m "fix: stabilize docs search verification"
```

