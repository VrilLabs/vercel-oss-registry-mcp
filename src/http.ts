import { serve } from '@hono/node-server';
import { createApp } from './routes.ts';

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp().fetch, port, hostname: '127.0.0.1' }, () => {
    console.error(`[vercel-oss-registry] http://127.0.0.1:${port}/mcp`);
});
