import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { catalog } from './catalog.ts';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './mcp.ts';

/** Stateless Streamable HTTP app — works on Node, Vercel Functions, Bun, Deno. */
export function createApp(opts: { allowedHosts?: string[] } = {}) {
    const handler = createMcpHandler(buildServer);
    const app = createMcpHonoApp(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {});

    app.get('/health', c => c.json({ status: 'ok', projects: catalog.count, generatedAt: catalog.generatedAt }));

    // Server Card (experimental SEP-2127) for discovery.
    const card = (base: string) => ({
        $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
        name: `io.github.vercel-oss-registry/${SERVER_NAME}`,
        title: 'Vercel OSS Registry',
        version: SERVER_VERSION,
        description: `Search the ${catalog.count} projects funded by the Vercel Open Source Program.`,
        websiteUrl: catalog.source,
        remotes: [{ type: 'streamable-http', url: `${base}/mcp` }]
    });
    app.get('/mcp/server-card', c => c.json(card(new URL(c.req.url).origin), 200, { 'cache-control': 'public, max-age=3600' }));
    app.get('/.well-known/mcp/server-card.json', c => c.json(card(new URL(c.req.url).origin)));

    app.all('/mcp', c => handler.fetch(c.req.raw));
    return app;
}
