import { TFile } from 'obsidian';

/**
 * Determines whether a file should be excluded from automatic frontmatter writes.
 * Parses the raw newline/comma-separated exclusion patterns from settings and
 * matches them against file paths and basenames.
 */
export class AutoFrontmatterExclusionService {
    constructor(private getExclusionPatterns: () => string) {}

    shouldIgnore(file: TFile): boolean {
        if (!(file instanceof TFile)) return false;
        const patterns = this.parsePatterns();
        if (!patterns.length) return false;
        const normalizedPath = this.normalizePath(file.path);
        const normalizedBasename = this.normalizePath(file.basename);
        return patterns.some((pattern) =>
            this.matchesPattern(normalizedPath, normalizedBasename, pattern),
        );
    }

    matchesPattern(
        normalizedPath: string,
        normalizedBasename: string,
        rawPattern: string,
    ): boolean {
        const pattern = String(rawPattern || '').trim();
        if (!pattern) return false;
        const asLower = pattern.toLowerCase();

        if (asLower.startsWith('re:')) {
            const source = pattern.slice(3).trim();
            if (!source) return false;
            try {
                const regex = new RegExp(source, 'i');
                return regex.test(normalizedPath) || regex.test(normalizedBasename);
            } catch {
                return false;
            }
        }

        if (asLower.startsWith('name:')) {
            const target = this.normalizePath(pattern.slice(5));
            if (!target) return false;
            return this.matchesWildcard(target, normalizedBasename);
        }

        const pathTarget = asLower.startsWith('path:') ? pattern.slice(5).trim() : pattern;
        const hasTrailingSlash = /[\/\\]$/.test(pathTarget);
        const normalizedTarget = this.normalizePath(pathTarget);
        if (!normalizedTarget) return false;

        if (normalizedTarget.includes('*')) {
            return (
                this.matchesWildcard(normalizedTarget, normalizedPath) ||
                this.matchesWildcard(normalizedTarget, normalizedBasename)
            );
        }

        if (hasTrailingSlash) {
            return normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`);
        }

        return (
            normalizedPath === normalizedTarget ||
            normalizedPath.startsWith(`${normalizedTarget}/`) ||
            normalizedBasename === normalizedTarget
        );
    }

    private parsePatterns(): string[] {
        const raw = String(this.getExclusionPatterns() || '');
        if (!raw.trim()) return [];
        return raw
            .split(/\r?\n|,/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }

    private normalizePath(value: string): string {
        return String(value || '')
            .trim()
            .replace(/^\/+/, '')
            .replace(/\/+$/, '')
            .toLowerCase();
    }

    private matchesWildcard(pattern: string, value: string): boolean {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
        return regex.test(value);
    }
}
