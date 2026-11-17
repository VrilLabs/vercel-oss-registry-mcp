// Vercel zero-config Hono entrypoint (Node.js runtime on Fluid Compute).
// Clients connect via Streamable HTTP at https://vercel-oss.vril.dev/mcp.
import { Hono } from 'hono';
import { createApp } from './routes.ts';

const DEFAULT_HOSTS = ['vercel-oss.vril.dev'];
const allowedHosts = [
    ...(process.env.ALLOWED_HOSTS?.split(',').map(h => h.trim()).filter(Boolean) ?? DEFAULT_HOSTS),
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
].filter((h): h is string => !!h);

const app = new Hono();
app.get('/', c => c.redirect('/mcp/server-card'));
app.route('/', createApp({ allowedHosts }));

export default app;
