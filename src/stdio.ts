#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './mcp.ts';

void serveStdio(buildServer);
console.error('[vercel-oss-registry] serving over stdio');
