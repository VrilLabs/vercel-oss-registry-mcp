import MiniSearch from 'minisearch';
import raw from '../data/catalog.json' with { type: 'json' };
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

const index = new MiniSearch<Project>({
    fields: ['name', 'repo', 'topicText', 'description', 'language'],
    extractField: (doc, field) =>
        field === 'topicText' ? doc.topics.join(' ') : String((doc as unknown as Record<string, unknown>)[field] ?? ''),
    searchOptions: { boost: { name: 4, repo: 2, topicText: 2.5, description: 1, language: 0.5 }, prefix: true, fuzzy: 0.2 }
});
index.addAll(catalog.projects);

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
        const run = (combineWith: 'AND' | 'OR') =>
            index.search(q, { combineWith, filter: r => pass(byId.get(r.id as string)!) }).map(r => byId.get(r.id as string)!);
        list = run('AND');
        mode = 'and';
        // Fall back to OR so multi-word queries still return the closest matches.
        if (list.length === 0) {
            list = run('OR');
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
    return index.search(input.replace(/[/_-]/g, ' '), { combineWith: 'OR' }).slice(0, n).map(r => r.id as string);
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
