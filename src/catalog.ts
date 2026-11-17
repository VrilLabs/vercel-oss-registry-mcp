import raw from '../data/catalog.json' with { type: 'json' };
import { SearchIndex } from './search.ts';
import type { Catalog, Project } from './types.ts';

export const catalog = raw as Catalog;
export const byId = new Map<string, Project>(catalog.projects.map(p => [p.id, p]));

/** Repos whose GitHub description signals they are no longer the original project. */
const SUSPECT = /reclaimed for security research|this repository has been (hijacked|taken over)/i;
export const warningFor = (p: Project): string | null =>
    !p.available ? 'Repository no longer resolves on GitHub (deleted, renamed or private).'
    : SUSPECT.test(p.description) ? 'Repository appears to have changed ownership; verify before use.'
    : p.archived ? 'Repository is archived.'
    : null;

const index = new SearchIndex<Project>(
    {
        id: p => p.id,
        fields: {
            name: { get: p => p.name, boost: 4 },
            repo: { get: p => p.repo, boost: 2 },
            topics: { get: p => p.topics.join(' '), boost: 2.5 },
            description: { get: p => p.description, boost: 1 },
            language: { get: p => p.language ?? '', boost: 0.5 }
        }
    },
    catalog.projects
);

export interface SearchParams {
    query?: string;
    topic?: string;
    language?: string;
    cohort?: string;
    minStars?: number;
    includeUnavailable?: boolean;
    sort?: 'relevance' | 'stars' | 'recent';
    limit: number;
    offset: number;
}

const norm = (s: string) => s.trim().toLowerCase();

export function search(p: SearchParams): { total: number; hits: Project[]; mode: 'all' | 'and' | 'or' } {
    const pass = (x: Project) =>
        (p.includeUnavailable || (x.available && !warningFor(x)?.startsWith('Repository appears'))) &&
        (!p.topic || x.topics.some(t => t === norm(p.topic!))) &&
        (!p.language || norm(x.language ?? '') === norm(p.language)) &&
        (!p.cohort || norm(x.cohort) === norm(p.cohort)) &&
        x.stars >= (p.minStars ?? 0);

    let mode: 'all' | 'and' | 'or' = 'all';
    let list: Project[];
    const q = p.query?.trim();
    if (q) {
        const run = (all: boolean) => index.search(q, { all, filter: id => pass(byId.get(id)!) }).map(r => byId.get(r.id)!);
        list = run(true);
        mode = 'and';
        // Fall back to OR so multi-word queries still return the closest matches.
        if (list.length === 0) {
            list = run(false);
            mode = 'or';
        }
    } else {
        list = catalog.projects.filter(pass);
    }

    const sort = p.sort ?? (q ? 'relevance' : 'stars');
    if (sort === 'stars') list = [...list].sort((a, b) => b.stars - a.stars);
    else if (sort === 'recent') list = [...list].sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));

    return { total: list.length, hits: list.slice(p.offset, p.offset + p.limit), mode };
}

/** Closest ids for a miss — powers "did you mean". */
export function suggestIds(input: string, n = 3): string[] {
    return index.search(input, { all: false }).slice(0, n).map(r => r.id);
}

export type Facet = 'topic' | 'language' | 'cohort';
export function facetCounts(facet: Facet): { value: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const p of catalog.projects) {
        const values = facet === 'topic' ? p.topics : facet === 'language' ? (p.language ? [p.language] : []) : [p.cohort];
        for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
