/**
 * Tiny dependency-free BM25F-style index with prefix + typo-tolerant matching.
 * Sized for small catalogs (hundreds of docs): built once per instance in <5ms.
 */

export type FieldGetter<T> = (doc: T) => string;

export interface IndexOptions<T> {
    id: (doc: T) => string;
    fields: Record<string, { get: FieldGetter<T>; boost: number }>;
}

interface Posting {
    /** term frequency per field */
    tf: Map<string, number>;
}

const K1 = 1.2;
const B = 0.75;

export const tokenize = (s: string): string[] =>
    s
        .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → camel Case
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter(t => t.length > 1 || /\d/.test(t));

/** Bounded Damerau (optimal string alignment) distance: a transposition costs 1. Returns max+1 once exceeded. */
export function editDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2: number[] = [];
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
            cur.push(v);
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return max + 1;
        prev2 = prev;
        prev = cur;
    }
    return prev[b.length]!;
}

export class SearchIndex<T> {
    private readonly ids: string[] = [];
    private readonly fieldLen: Map<string, number>[] = [];
    private readonly avgLen = new Map<string, number>();
    /** term → docIndex → posting */
    private readonly postings = new Map<string, Map<number, Posting>>();
    private readonly expansionCache = new Map<string, [string, number][]>();

    constructor(
        private readonly opts: IndexOptions<T>,
        docs: readonly T[]
    ) {
        const totals = new Map<string, number>();
        docs.forEach((doc, d) => {
            this.ids.push(opts.id(doc));
            const lens = new Map<string, number>();
            for (const [field, { get }] of Object.entries(opts.fields)) {
                const tokens = tokenize(get(doc));
                lens.set(field, tokens.length);
                totals.set(field, (totals.get(field) ?? 0) + tokens.length);
                for (const t of tokens) {
                    let byDoc = this.postings.get(t);
                    if (!byDoc) this.postings.set(t, (byDoc = new Map()));
                    let p = byDoc.get(d);
                    if (!p) byDoc.set(d, (p = { tf: new Map() }));
                    p.tf.set(field, (p.tf.get(field) ?? 0) + 1);
                }
            }
            this.fieldLen.push(lens);
        });
        for (const [f, total] of totals) this.avgLen.set(f, total / Math.max(docs.length, 1));
    }

    /** Vocabulary terms a query term matches, with a match-quality weight (exact 1, prefix 0.75, typo 0.45). */
    private expand(term: string): [string, number][] {
        const hit = this.expansionCache.get(term);
        if (hit) return hit;
        const out: [string, number][] = [];
        const maxTypos = term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;
        for (const vocab of this.postings.keys()) {
            if (vocab === term) out.push([vocab, 1]);
            else if (term.length >= 2 && vocab.startsWith(term)) out.push([vocab, 0.75]);
            else if (maxTypos && editDistance(term, vocab, maxTypos) <= maxTypos) out.push([vocab, 0.45]);
        }
        if (this.expansionCache.size > 2000) this.expansionCache.clear();
        this.expansionCache.set(term, out);
        return out;
    }

    /** Returns ids ordered by score. `all` requires every query term to match. */
    search(query: string, { all, filter }: { all: boolean; filter?: (id: string) => boolean }): { id: string; score: number }[] {
        const terms = [...new Set(tokenize(query))];
        if (!terms.length) return [];
        const N = this.ids.length;
        const scores = new Map<number, number>();
        const matchedTerms = new Map<number, number>();

        for (const term of terms) {
            const perDoc = new Map<number, number>();
            for (const [vocab, quality] of this.expand(term)) {
                const byDoc = this.postings.get(vocab)!;
                const idf = Math.log(1 + (N - byDoc.size + 0.5) / (byDoc.size + 0.5));
                for (const [d, { tf }] of byDoc) {
                    let s = 0;
                    for (const [field, f] of tf) {
                        const { boost } = this.opts.fields[field]!;
                        const len = this.fieldLen[d]!.get(field) ?? 0;
                        const avg = this.avgLen.get(field) || 1;
                        s += (boost * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * len) / avg));
                    }
                    // Keep the best expansion per (term, doc) so typo variants don't stack.
                    perDoc.set(d, Math.max(perDoc.get(d) ?? 0, idf * s * quality));
                }
            }
            for (const [d, s] of perDoc) {
                scores.set(d, (scores.get(d) ?? 0) + s);
                matchedTerms.set(d, (matchedTerms.get(d) ?? 0) + 1);
            }
        }

        const out: { id: string; score: number }[] = [];
        for (const [d, score] of scores) {
            const id = this.ids[d]!;
            if (all && matchedTerms.get(d) !== terms.length) continue;
            if (filter && !filter(id)) continue;
            // Reward covering more of the query in OR mode.
            out.push({ id, score: score * (all ? 1 : (matchedTerms.get(d)! / terms.length) ** 0.5) });
        }
        return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    }
}
