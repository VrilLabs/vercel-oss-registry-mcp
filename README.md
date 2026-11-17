# Vercel OSS Registry MCP

An MCP server that lets you search every project in the [Vercel Open Source Program](https://vercel.com/open-source-program): 138 projects across 5 cohorts, from Spring 2025 to Spring 2026. Each project has its GitHub link, description, topics (usable as keywords), language, license, stars and activity.

It is built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, spec 2026-07-28).

## Tools (progressive disclosure)

| Tool | Returns |
|---|---|
| `search_projects` | Short results (id, name, one-line summary, top 5 topics, stars). Supports fuzzy and prefix full-text search, filters by topic, language, cohort and minimum stars, sorting, and pagination. |
| `get_project` | The full record for 1–10 ids, plus `resource_link`s. Unknown ids come back with "did you mean" suggestions. |
| `list_facets` | The valid topic, language and cohort values, with counts. |

Resources:
- `vercel-oss://projects/{owner}/{repo}`: one project as Markdown, with owner/repo completion.
- `vercel-oss://facets`
- `vercel-oss://catalog`: the full JSON.

All tools are read-only and idempotent and declare an `outputSchema`. List and read results include cache hints with a 1-day TTL.

## Use

```bash
pnpm install
pnpm stdio            # stdio transport
pnpm dev              # Streamable HTTP on http://127.0.0.1:3000/mcp
pnpm inspect          # MCP Inspector
```

Claude Code: `claude mcp add vercel-oss -- npx tsx /path/to/src/stdio.ts`

HTTP endpoints: `/mcp`, `/health`, `/mcp/server-card` (Server Card, SEP-2127).

## Catalog

`data/catalog.json` is built ahead of time, so the server makes no GitHub calls at runtime:

```bash
pnpm catalog          # scrape vercel.com/open-source-program + GitHub GraphQL enrichment
pnpm catalog:check    # exit 1 if the page lists repos missing from the catalog
```

The builder refuses to write the file if it parses fewer entries than there are unique repo links on the page. A weekly GitHub Action rebuilds the catalog and opens a PR.

Repos that no longer resolve or have changed hands (`warning` field) are hidden from search by default. Pass `includeUnavailable: true` to show them.

## Deploy

`vercel deploy`: `api/index.ts` runs the Hono app on Fluid Compute (Node). Set `ALLOWED_HOSTS` to cover any custom domains.
