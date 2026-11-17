import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { byId, catalog, facetCounts, search, suggestIds, warningFor } from './catalog.ts';
import type { Project } from './types.ts';

export const SERVER_NAME = 'vercel-oss-registry';
export const SERVER_VERSION = '0.1.0';

const URI = { project: (id: string) => `vercel-oss://projects/${id}`, facets: 'vercel-oss://facets', catalog: 'vercel-oss://catalog' };
const DAY = 86_400_000;

const INSTRUCTIONS = `Catalog of the ${catalog.count} open-source projects funded by the Vercel Open Source Program (${catalog.cohorts.join(', ')}).
Use it when a developer needs a library, UI kit, starter, tool or app to build on.
Workflow (progressive disclosure — fetch only what you need):
1. search_projects: compact hits (id, name, one-line summary, top topics, stars). Filter by topic/language/cohort; page with offset.
2. get_project: full record for 1-10 ids (repo URL, full description, all topics, homepage, license, activity).
3. list_facets: discover valid topic/language/cohort filter values before filtering.
Every project is also readable as the resource vercel-oss://projects/{owner}/{repo}.`;

// ── shared shapes ───────────────────────────────────────────────────────────


const Hit = z.object({
    id: z.string().describe('owner/repo, lowercase — pass to get_project'),
    name: z.string(),
    summary: z.string(),
    topics: z.array(z.string()),
    stars: z.number(),
    language: z.string().nullable(),
    warning: z.string().optional()
});

const Detail = z.object({
    id: z.string(),
    name: z.string(),
    repo: z.string(),
    url: z.string(),
    description: z.string(),
    topics: z.array(z.string()),
    homepage: z.string().nullable(),
    language: z.string().nullable(),
    license: z.string().nullable(),
    stars: z.number(),
    forks: z.number(),
    archived: z.boolean(),
    pushedAt: z.string().nullable(),
    cohort: z.string(),
    warning: z.string().optional()
});

const oneLine = (s: string, max = 120) => {
    const first = s.split(/(?<=[.!?])\s/)[0] ?? s;
    return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
};

function toHit(p: Project): z.infer<typeof Hit> {
    const warning = warningFor(p);
    return {
        id: p.id,
        name: p.name,
        summary: oneLine(p.description) || '(no description)',
        topics: p.topics.slice(0, 5),
        stars: p.stars,
        language: p.language,
        ...(warning && { warning })
    };
}

function toDetail(p: Project): z.infer<typeof Detail> {
    const warning = warningFor(p);
    // Explicit pick: the outputSchema is strict, so new catalog fields must be opted in here.
    const { id, name, repo, url, description, topics, homepage, language, license, stars, forks, archived, pushedAt, cohort } = p;
    return { id, name, repo, url, description, topics, homepage, language, license, stars, forks, archived, pushedAt, cohort, ...(warning && { warning }) };
}

const asMarkdown = (p: Project) =>
    [
        `# ${p.name} — ${p.repo}`,
        p.description,
        '',
        `- Repo: ${p.url}`,
        p.homepage && `- Homepage: ${p.homepage}`,
        `- Topics: ${p.topics.join(', ') || '—'}`,
        `- Language: ${p.language ?? '—'} · License: ${p.license ?? '—'} · ★ ${p.stars} · Cohort: ${p.cohort}`,
        warningFor(p) && `- ⚠️ ${warningFor(p)}`
    ]
        .filter(l => l !== null && l !== '')
        .join('\n');

// ── server ──────────────────────────────────────────────────────────────────

export function buildServer(): McpServer {
    const server = new McpServer(
        { name: SERVER_NAME, title: 'Vercel OSS Registry', version: SERVER_VERSION, websiteUrl: catalog.source },
        {
            instructions: INSTRUCTIONS,
            // The catalog only changes on redeploy: let clients cache lists for a day.
            cacheHints: {
                'tools/list': { ttlMs: DAY, cacheScope: 'public' },
                'resources/list': { ttlMs: DAY, cacheScope: 'public' },
                'resources/templates/list': { ttlMs: DAY, cacheScope: 'public' }
            }
        }
    );

    const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false } as const;

    server.registerTool(
        'search_projects',
        {
            title: 'Search Vercel OSS projects',
            description:
                'Full-text search (fuzzy, prefix) over Vercel OSS Program projects by name, topics and description, with optional filters. Returns compact hits; call get_project for full details. Omit query to browse by filters.',
            inputSchema: z.object({
                query: z.string().max(200).optional().describe('Keywords, e.g. "animated react components" or "auth"'),
                topic: z.string().max(60).optional().describe('Exact GitHub topic (see list_facets)'),
                language: z.string().max(40).optional().describe('Primary language, e.g. TypeScript'),
                cohort: z.string().max(20).optional().describe('e.g. "Spring 2026"'),
                minStars: z.number().int().min(0).optional(),
                sort: z.enum(['relevance', 'stars', 'recent']).optional().describe('Default: relevance with query, stars without'),
                limit: z.number().int().min(1).max(25).default(10),
                offset: z.number().int().min(0).default(0),
                includeUnavailable: z.boolean().default(false).describe('Include repos that are gone or flagged')
            }),
            outputSchema: z.object({
                total: z.number(),
                offset: z.number(),
                nextOffset: z.number().nullable(),
                matchMode: z.enum(['all', 'and', 'or']).describe('"or" means no project matched every term'),
                hits: z.array(Hit)
            }),
            annotations: readOnly
        },
        async args => {
            const { total, hits, mode } = search(args);
            const nextOffset = args.offset + hits.length < total ? args.offset + hits.length : null;
            const structuredContent = { total, offset: args.offset, nextOffset, matchMode: mode, hits: hits.map(toHit) };
            const lines = structuredContent.hits.map(
                h => `- ${h.id} — ${h.name}: ${h.summary} [${h.topics.join(', ')}] ★${h.stars}${h.warning ? ` ⚠️ ${h.warning}` : ''}`
            );
            const header =
                total === 0
                    ? 'No matches. Try fewer/broader keywords or list_facets for valid filters.'
                    : `${total} match${total === 1 ? '' : 'es'}${mode === 'or' ? ' (partial — no project matched every term)' : ''}; showing ${args.offset + 1}-${args.offset + hits.length}.${nextOffset !== null ? ` Next page: offset=${nextOffset}.` : ''}`;
            return { content: [{ type: 'text', text: [header, ...lines].join('\n') }], structuredContent } satisfies CallToolResult;
        }
    );

    server.registerTool(
        'get_project',
        {
            title: 'Get Vercel OSS project details',
            description: 'Full catalog record(s) for one or more project ids (owner/repo) returned by search_projects.',
            inputSchema: z.object({
                ids: z.array(z.string().max(140)).min(1).max(10).describe('owner/repo ids, case-insensitive; a full GitHub URL also works')
            }),
            outputSchema: z.object({
                projects: z.array(Detail),
                notFound: z.array(z.object({ id: z.string(), didYouMean: z.array(z.string()) }))
            }),
            annotations: readOnly
        },
        async ({ ids }) => {
            const projects: z.infer<typeof Detail>[] = [];
            const notFound: { id: string; didYouMean: string[] }[] = [];
            const content: CallToolResult['content'] = [];
            for (const raw of ids) {
                const id = raw
                    .trim()
                    .replace(/^https?:\/\/github\.com\//i, '')
                    .replace(/\/$/, '')
                    .toLowerCase();
                const p = byId.get(id);
                if (!p) {
                    notFound.push({ id: raw, didYouMean: suggestIds(id) });
                    continue;
                }
                projects.push(toDetail(p));
                content.push({ type: 'text', text: asMarkdown(p) });
                content.push({ type: 'resource_link', uri: URI.project(p.id), name: p.id, title: p.name, mimeType: 'text/markdown' });
            }
            for (const n of notFound)
                content.push({ type: 'text', text: `Not found: ${n.id}.${n.didYouMean.length ? ` Did you mean: ${n.didYouMean.join(', ')}?` : ''}` });
            return { content, structuredContent: { projects, notFound }, isError: projects.length === 0 };
        }
    );

    server.registerTool(
        'list_facets',
        {
            title: 'List filter values',
            description: 'Values (with project counts) for a filter: topic, language or cohort. Use to pick valid search_projects filters.',
            inputSchema: z.object({
                facet: z.enum(['topic', 'language', 'cohort']),
                limit: z.number().int().min(1).max(200).default(40)
            }),
            outputSchema: z.object({
                facet: z.string(),
                total: z.number(),
                values: z.array(z.object({ value: z.string(), count: z.number() }))
            }),
            annotations: readOnly
        },
        async ({ facet, limit }) => {
            const all = facetCounts(facet);
            const values = all.slice(0, limit);
            return {
                content: [{ type: 'text', text: `${all.length} ${facet} values${all.length > limit ? ` (top ${limit})` : ''}: ${values.map(v => `${v.value} (${v.count})`).join(', ')}` }],
                structuredContent: { facet, total: all.length, values }
            };
        }
    );

    // ── resources ───────────────────────────────────────────────────────────

    server.registerResource(
        'project',
        new ResourceTemplate('vercel-oss://projects/{owner}/{repo}', {
            list: async () => ({
                resources: catalog.projects.map(p => ({
                    uri: URI.project(p.id),
                    name: p.id,
                    title: p.name,
                    description: oneLine(p.description, 160),
                    mimeType: 'text/markdown'
                }))
            }),
            complete: {
                owner: v => [...new Set(catalog.projects.map(p => p.id.split('/')[0]!))].filter(o => o.startsWith(v.toLowerCase())).slice(0, 50),
                repo: (v, ctx) => {
                    const owner = ctx?.arguments?.owner?.toLowerCase();
                    return catalog.projects
                        .filter(p => (!owner || p.id.startsWith(`${owner}/`)) && p.id.split('/')[1]!.startsWith(v.toLowerCase()))
                        .map(p => p.id.split('/')[1]!)
                        .slice(0, 50);
                }
            }
        }),
        { title: 'Vercel OSS project', description: 'One project as Markdown', mimeType: 'text/markdown', cacheHint: { ttlMs: DAY, cacheScope: 'public' } },
        async (uri, vars) => {
            const id = `${vars.owner}/${vars.repo}`.toLowerCase();
            const p = byId.get(id);
            if (!p) throw new Error(`Unknown project ${id}`);
            return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: asMarkdown(p) }] };
        }
    );

    server.registerResource(
        'facets',
        URI.facets,
        { title: 'Catalog facets', description: 'All topics, languages and cohorts with counts', mimeType: 'application/json', cacheHint: { ttlMs: DAY, cacheScope: 'public' } },
        async uri => ({
            contents: [
                {
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify({ topic: facetCounts('topic'), language: facetCounts('language'), cohort: facetCounts('cohort') })
                }
            ]
        })
    );

    server.registerResource(
        'catalog',
        URI.catalog,
        { title: 'Full catalog', description: `Complete JSON catalog (${catalog.count} projects) for bulk use`, mimeType: 'application/json', cacheHint: { ttlMs: DAY, cacheScope: 'public' } },
        async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(catalog) }] })
    );

    return server;
}
