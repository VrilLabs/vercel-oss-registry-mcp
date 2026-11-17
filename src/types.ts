export interface Project {
    /** Lowercased `owner/repo` — stable lookup key. */
    id: string;
    /** Display name as listed by Vercel. */
    name: string;
    /** Canonical `Owner/Repo` (follows GitHub renames). */
    repo: string;
    url: string;
    /** `owner/repo` exactly as linked on the Vercel page (may predate a GitHub rename). */
    listedAs: string;
    description: string;
    /** GitHub topics, used as keywords. */
    topics: string[];
    homepage: string | null;
    language: string | null;
    license: string | null;
    stars: number;
    forks: number;
    archived: boolean;
    pushedAt: string | null;
    createdAt: string | null;
    /** Vercel OSS Program cohort, e.g. "Spring 2026". */
    cohort: string;
    /** False if the repo could not be resolved on GitHub at build time. */
    available: boolean;
}

export interface Catalog {
    source: string;
    generatedAt: string;
    count: number;
    cohorts: string[];
    projects: Project[];
}
