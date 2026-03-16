import { TFile } from "obsidian";
import { Logger } from "./logger";
import { NotebookNavigatorCompanionSettings } from "../types";

/**
 * Determines whether a file should be excluded from companion frontmatter writes.
 * Applies a 2-second grace period for newly created files, then evaluates
 * path/name/regex patterns from settings.
 *
 * Extracted from main.ts to keep the main class under 500 lines.
 */
export class FrontmatterWriteExclusionService {
    constructor(
        private logger: Logger,
        private getSettings: () => NotebookNavigatorCompanionSettings,
    ) {}

    shouldIgnore(file: TFile, options?: { bypassCreationGrace?: boolean }): boolean {
        if (!(file instanceof TFile)) return false;

        // Grace period: allow Templater / TPS-Controller to finish initialization
        const age = Date.now() - file.stat.ctime;
        if (!options?.bypassCreationGrace && age < 2000) return true;

        const patterns = this.getPatterns();
        if (!patterns.length) return false;

        const normalizedPath = this.normalizePath(file.path);
        const normalizedBasename = String(file.basename || "").trim().toLowerCase();

        for (const pattern of patterns) {
            if (this.matchesPattern(normalizedPath, normalizedBasename, pattern)) {
                this.logger.debug("Skipping companion frontmatter write due to exclusion", {
                    file: file.path,
                    pattern,
                });
                return true;
            }
        }

        return false;
    }

    private getPatterns(): string[] {
        const raw = String(this.getSettings().frontmatterWriteExclusions || "");
        if (!raw.trim()) return [];
        return raw
            .split(/\r?\n|,/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }

    private matchesPattern(
        normalizedPath: string,
        normalizedBasename: string,
        rawPattern: string,
    ): boolean {
        const pattern = String(rawPattern || "").trim();
        if (!pattern) return false;

        const asLower = pattern.toLowerCase();

        if (asLower.startsWith("re:")) {
            const source = pattern.slice(3).trim();
            if (!source) return false;
            try {
                const regex = new RegExp(source, "i");
                return regex.test(normalizedPath) || regex.test(normalizedBasename);
            } catch {
                return false;
            }
        }

        if (asLower.startsWith("name:")) {
            const target = String(pattern.slice(5) || "").trim().toLowerCase();
            if (!target) return false;
            return this.matchesWildcard(target, normalizedBasename);
        }

        const pathTarget = asLower.startsWith("path:") ? pattern.slice(5).trim() : pattern;
        const hasTrailingSlash = /[\/\\]$/.test(pathTarget);
        const normalizedTarget = this.normalizePath(pathTarget);
        if (!normalizedTarget) return false;

        if (normalizedTarget.includes("*")) {
            return (
                this.matchesWildcard(normalizedTarget, normalizedPath) ||
                this.matchesWildcard(normalizedTarget, normalizedBasename)
            );
        }

        if (hasTrailingSlash) {
            return normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`);
        }

        if (normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`)) {
            return true;
        }

        return normalizedBasename === normalizedTarget;
    }

    private matchesWildcard(pattern: string, value: string): boolean {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
        return regex.test(value);
    }

    private normalizePath(value: string): string {
        if (!value || typeof value !== "string") return "";
        return value.trim()
            .replace(/^\/+/, "")
            .replace(/\/+$/, "")
            .toLowerCase();
    }
}
