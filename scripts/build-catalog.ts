/**
 * Builds data/catalog.json from vercel.com/open-source-program, enriched via GitHub GraphQL.
 *
 *   pnpm catalog              # GITHUB_TOKEN env, or falls back to `gh auth token`
 *   pnpm catalog --check      # exit 1 if the page and the committed catalog disagree
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Catalog, Project } from '../src/types.ts';

const SOURCE_URL = 'https://vercel.com/open-source-program';
const OUT = fileURLToPath(new URL('../data/catalog.json', import.meta.url));
const BATCH = 40;

interface ScrapedEntry {
    owner: string;
    repo: string;
    name: string;
    cohort: string;
}

const decode = (s: string) =>
    s
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();

export function parseProgramPage(html: string): ScrapedEntry[] {
    const body = html.replace(/<script[\s\S]*?<\/script>/g, '');
    const re =
        /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>|<li[^>]*text-left[^>]*>\s*<a href="https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?"[^>]*>([\s\S]*?)<\/a>/g;
    const out: ScrapedEntry[] = [];
    const seen = new Set<string>();
    let cohort = 'Unknown';
    for (let m = re.exec(body); m; m = re.exec(body)) {
        if (m[1] !== undefined) {
            const h = decode(m[1]);
            const season = /(Spring|Summer|Fall|Winter) \d{4}/.exec(h);
            if (season) cohort = season[0];
            continue;
        }
        const [owner, repo, inner] = [m[2]!, m[3]!, m[4]!];
        const key = `${owner}/${repo}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // Newer cohort cards render "<Name><owner>/<repo>" — strip the trailing slug.
        let name = decode(inner).replace(/\s+/g, ' ');
        const slug = `${owner}/${repo}`;
        if (name.toLowerCase().endsWith(slug.toLowerCase()) && name.length > slug.length) name = name.slice(0, -slug.length).trim();
        out.push({ owner, repo, name: name || repo, cohort });
    }
    // Past-cohort headings follow the "See past cohorts." h2 in document order; entries before any season fall back.
    return out;
}

function token(): string {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

const FIELDS = `
  nameWithOwner url description homepageUrl stargazerCount forkCount isArchived pushedAt createdAt
  primaryLanguage { name }
  licenseInfo { spdxId }
  repositoryTopics(first: 30) { nodes { topic { name } } }
  readme: object(expression: "HEAD:README.md") { ... on Blob { text } }`;

/** First prose paragraph of a README, stripped of markdown/HTML noise. */
export function readmeSummary(md: string | undefined, max = 280): string {
    if (!md) return '';
    const para = md
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/```[\s\S]*?```/g, '')
        .split(/\n\s*\n/)
        .map(p =>
            p
                .replace(/<[^>]+>/g, '')
                .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
                .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
                .replace(/[*_`>#]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
        )
        .find(p => p.length >= 40 && !/^(\||-{3,}|=)/.test(p));
    if (!para) return '';
    return para.length > max ? `${para.slice(0, max - 1).trimEnd()}…` : para;
}

interface GhRepo {
    nameWithOwner: string;
    url: string;
    description: string | null;
    homepageUrl: string | null;
    stargazerCount: number;
    forkCount: number;
    isArchived: boolean;
    pushedAt: string | null;
    createdAt: string;
    primaryLanguage: { name: string } | null;
    licenseInfo: { spdxId: string } | null;
    repositoryTopics: { nodes: { topic: { name: string } }[] };
    readme: { text?: string } | null;
}

async function enrich(entries: ScrapedEntry[]): Promise<(GhRepo | null)[]> {
    const auth = token();
    const results: (GhRepo | null)[] = [];
    for (let i = 0; i < entries.length; i += BATCH) {
        const chunk = entries.slice(i, i + BATCH);
        const query = `query {${chunk
            .map((e, j) => `r${j}: repository(owner: ${JSON.stringify(e.owner)}, name: ${JSON.stringify(e.repo)}) {${FIELDS}}`)
            .join('\n')}}`;
        const res = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: { authorization: `bearer ${auth}`, 'content-type': 'application/json', 'user-agent': 'vercel-oss-registry-mcp' },
            body: JSON.stringify({ query })
        });
        if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as { data?: Record<string, GhRepo | null>; errors?: { message: string }[] };
        for (const err of json.errors ?? []) console.warn(`[catalog] warn: ${err.message}`);
        chunk.forEach((_, j) => results.push(json.data?.[`r${j}`] ?? null));
    }
    return results;
}

function toProject(e: ScrapedEntry, gh: GhRepo | null): Project {
    const fullName = gh?.nameWithOwner ?? `${e.owner}/${e.repo}`;
    return {
        id: fullName.toLowerCase(),
        name: e.name,
        repo: fullName,
        url: gh?.url ?? `https://github.com/${e.owner}/${e.repo}`,
        listedAs: `${e.owner}/${e.repo}`,
        description: gh?.description?.trim() || readmeSummary(gh?.readme?.text),
        topics: gh?.repositoryTopics.nodes.map(n => n.topic.name) ?? [],
        homepage: gh?.homepageUrl || null,
        language: gh?.primaryLanguage?.name ?? null,
        license: gh?.licenseInfo?.spdxId && gh.licenseInfo.spdxId !== 'NOASSERTION' ? gh.licenseInfo.spdxId : null,
        stars: gh?.stargazerCount ?? 0,
        forks: gh?.forkCount ?? 0,
        archived: gh?.isArchived ?? false,
        pushedAt: gh?.pushedAt ?? null,
        createdAt: gh?.createdAt ?? null,
        cohort: e.cohort,
        available: gh !== null
    };
}

async function main() {
    const html = await (await fetch(SOURCE_URL, { headers: { 'user-agent': 'vercel-oss-registry-mcp' } })).text();
    const entries = parseProgramPage(html);
    const linkCount = new Set(
        [...html.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)].map(m => `${m[1]}/${m[2]}`.toLowerCase())
    ).size;
    console.error(`[catalog] parsed ${entries.length} entries (${linkCount} unique repo links on page)`);
    if (entries.length < linkCount) throw new Error(`parser missed ${linkCount - entries.length} repo links — markup changed?`);

    if (process.argv.includes('--check')) {
        const current = JSON.parse(readFileSync(OUT, 'utf8')) as Catalog;
        const have = new Set(current.projects.map(p => p.listedAs.toLowerCase()));
        const missing = entries.filter(e => !have.has(`${e.owner}/${e.repo}`.toLowerCase()));
        console.error(`[catalog] ${missing.length} new on page: ${missing.map(e => `${e.owner}/${e.repo}`).join(', ')}`);
        process.exit(missing.length ? 1 : 0);
    }

    const gh = await enrich(entries);
    const projects = entries.map((e, i) => toProject(e, gh[i] ?? null));
    const unavailable = projects.filter(p => !p.available);
    if (unavailable.length) console.warn(`[catalog] ${unavailable.length} repos unavailable: ${unavailable.map(p => p.repo).join(', ')}`);

    const catalog: Catalog = {
        source: SOURCE_URL,
        generatedAt: new Date().toISOString(),
        count: projects.length,
        cohorts: [...new Set(projects.map(p => p.cohort))],
        projects
    };
    writeFileSync(OUT, `${JSON.stringify(catalog, null, 2)}\n`);
    console.error(`[catalog] wrote ${projects.length} projects across ${catalog.cohorts.join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
