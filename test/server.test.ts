import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { parseProgramPage, readmeSummary } from '../scripts/build-catalog.ts';
import { catalog, search } from '../src/catalog.ts';
import { createApp } from '../src/routes.ts';

describe('catalog', () => {
    it('has every project with url, description field and topics array', () => {
        expect(catalog.count).toBe(catalog.projects.length);
        expect(catalog.count).toBeGreaterThanOrEqual(138);
        for (const p of catalog.projects) {
            expect(p.url).toMatch(/^https:\/\/github\.com\//);
            expect(Array.isArray(p.topics)).toBe(true);
        }
        expect(catalog.cohorts.length).toBeGreaterThanOrEqual(5);
    });

    it('parses both card styles and cohort headings', () => {
        const html = `<h2>Our <!-- -->Spring 2026<!-- --> Cohort.</h2>
<li class="x text-left" data-grid-cell=""><a href="https://github.com/a/b" rel="noopener">B Kit<span>a/b</span></a></li>
<h3>Fall 2025</h3><li class="text-left"><a href="https://github.com/c/d" target="_blank">D</a></li>`;
        expect(parseProgramPage(html)).toEqual([
            { owner: 'a', repo: 'b', name: 'B Kit', cohort: 'Spring 2026' },
            { owner: 'c', repo: 'd', name: 'D', cohort: 'Fall 2025' }
        ]);
    });

    it('extracts a README summary', () => {
        expect(readmeSummary('# T\n\n![x](y)\n\nA library of **fancy** animated [React](z) components for fun.')).toBe(
            'A library of fancy animated React components for fun.'
        );
    });

    it('ranks search and falls back to OR', () => {
        const r = search({ query: 'url state', limit: 5, offset: 0 });
        expect(r.hits.map(h => h.id)).toContain('47ng/nuqs');
        expect(search({ query: 'react zzzqqq', limit: 5, offset: 0 }).mode).toBe('or');
    });
});

describe('http', () => {
    it('serves health and server card', async () => {
        const app = createApp();
        const h = await app.request('http://127.0.0.1/health', { headers: { host: '127.0.0.1' } });
        expect((await h.json()).projects).toBe(catalog.count);
        const card = await (await app.request('http://127.0.0.1/mcp/server-card', { headers: { host: '127.0.0.1' } })).json();
        expect(card.remotes[0].url).toBe('http://127.0.0.1/mcp');
    });
});

describe('mcp end-to-end', () => {
    it('lists tools and runs the progressive-disclosure flow', async () => {
        const app = createApp();
        const client = new Client({ name: 't', version: '0' });
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
                fetch: async (input, init) => {
                    const headers = new Headers(init?.headers);
                    headers.set('host', '127.0.0.1');
                    return app.request(String(input), { ...init, headers });
                }
            })
        );
        const tools = await client.listTools();
        expect(tools.tools.map(t => t.name).sort()).toEqual(['get_project', 'list_facets', 'search_projects']);

        const s = await client.callTool({ name: 'search_projects', arguments: { query: 'animated icons', limit: 3 } });
        const sc = s.structuredContent as { hits: { id: string }[]; total: number };
        expect(sc.hits.length).toBeGreaterThan(0);
        // Token budget: compact hits stay small.
        expect(JSON.stringify(s.content).length / 4).toBeLessThan(400);

        const g = await client.callTool({ name: 'get_project', arguments: { ids: [sc.hits[0]!.id, 'nope/nope'] } });
        const gc = g.structuredContent as { projects: { url: string; topics: string[] }[]; notFound: unknown[] };
        expect(gc.projects[0]!.url).toMatch(/github\.com/);
        expect(gc.notFound).toHaveLength(1);

        const f = await client.callTool({ name: 'list_facets', arguments: { facet: 'cohort' } });
        expect((f.structuredContent as { total: number }).total).toBe(catalog.cohorts.length);

        const r = await client.readResource({ uri: 'vercel-oss://projects/47ng/nuqs' });
        expect((r.contents[0] as { text: string }).text).toContain('nuqs');
        await client.close();
    });
});
