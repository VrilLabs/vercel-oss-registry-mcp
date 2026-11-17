import { describe, expect, it } from 'vitest';
import { search, suggestIds } from '../src/catalog.ts';
import { editDistance, SearchIndex, tokenize } from '../src/search.ts';

describe('tokenize', () => {
    it('splits camelCase, punctuation and strips accents', () => {
        expect(tokenize('performativeUI shadcn-table Café v0')).toEqual(['performative', 'ui', 'shadcn', 'table', 'cafe', 'v0']);
    });
});

describe('editDistance', () => {
    it('is bounded', () => {
        expect(editDistance('valibot', 'valibto', 2)).toBe(1);
        expect(editDistance('valibot', 'vailbto', 1)).toBe(2);
        expect(editDistance('react', 'svelte', 1)).toBe(2);
    });
});

describe('SearchIndex', () => {
    const docs = [
        { id: 'a', name: 'Lenis', text: 'smooth scroll library' },
        { id: 'b', name: 'Scroller', text: 'virtual list' },
        { id: 'c', name: 'Other', text: 'nothing relevant here' }
    ];
    const idx = new SearchIndex(
        { id: d => d.id, fields: { name: { get: d => d.name, boost: 3 }, text: { get: d => d.text, boost: 1 } } },
        docs
    );

    it('matches exact, prefix and typo', () => {
        expect(idx.search('scroll', { all: true }).map(r => r.id).sort()).toEqual(['a', 'b']);
        expect(idx.search('scrol', { all: true }).map(r => r.id)).toContain('a');
        expect(idx.search('smoth', { all: true }).map(r => r.id)).toEqual(['a']);
    });

    it('AND requires every term, OR does not', () => {
        expect(idx.search('smooth virtual', { all: true })).toEqual([]);
        expect(idx.search('smooth virtual', { all: false }).map(r => r.id).sort()).toEqual(['a', 'b']);
    });
});

describe('catalog search quality', () => {
    const top = (query: string, n = 3) => search({ query, limit: n, offset: 0 }).hits.map(h => h.id);

    it.each([
        ['nuqs', '47ng/nuqs'],
        ['valibot', 'open-circle/valibot'],
        ['lenis smooth scroll', 'darkroomengineering/lenis'],
        ['valibto', 'open-circle/valibot']
    ])('%s → %s', (q, id) => {
        expect(top(q).map(x => x.toLowerCase())).toContain(id);
    });

    it('suggests close ids for a typo', () => {
        expect(suggestIds('47ng/nuq')).toContain('47ng/nuqs');
    });
});
