import { App, TFile, TFolder } from "obsidian";
import Se from "./main";

export class FilterService {
    app: App;
    plugin: Se;
    frontmatterCache: Map<string, any> = new Map();
    folderFilterMatchCache: Map<string, { version: number; result: boolean }> = new Map();
    filterMatchVersion: number = 0;
    bodyCache: Map<string, { mtime: number; content: string }> = new Map();
    pendingBodyReads: Set<string> = new Set();
    bodyRefreshTimer: number | null = null;

    constructor(app: App, plugin: Se) {
        this.app = app;
        this.plugin = plugin;
    }

    scheduleBodyRefresh() {
        if (this.bodyRefreshTimer !== null) return;
        this.bodyRefreshTimer = window.setTimeout(() => {
            this.bodyRefreshTimer = null;
            this.plugin.refreshAllExplorer2();
        }, 200);
    }

    getBodyContent(file: TFile): string | null {
        const cacheKey = file.path || "";
        const cached = this.bodyCache.get(cacheKey);
        if (cached && cached.mtime === file.stat?.mtime) {
            return cached.content;
        }

        // Use async read — returns stale/null on first call, triggers refresh when ready
        if (!this.pendingBodyReads.has(cacheKey)) {
            this.pendingBodyReads.add(cacheKey);
            const read = typeof this.app.vault.cachedRead === "function"
                ? this.app.vault.cachedRead(file)
                : this.app.vault.read(file);
            read.then((content: string) => {
                this.bodyCache.set(cacheKey, { mtime: file.stat?.mtime || 0, content });
                this.scheduleBodyRefresh();
            }).catch(() => {
                // Ignore read failures; we'll retry on next access
            }).finally(() => {
                this.pendingBodyReads.delete(cacheKey);
            });
        }

        return cached ? cached.content : null;
    }

    getFrontmatterValue(e: TFile, t: string) {
        if (!t) return;
        const cacheKey = e.path || "";

        // Always get fresh frontmatter from Obsidian's metadata cache
        // This ensures we don't use stale data when frontmatter is updated or reordered
        // The metadata cache is already efficient, so we rely on it as the source of truth
        let front = this.frontmatterCache.get(cacheKey);

        // If not cached OR cached as null (might have been accessed before metadata was ready),
        // always try to get fresh data from Obsidian's metadata cache
        if (!this.frontmatterCache.has(cacheKey) || front === null) {
            try {
                const fileCache = this.app.metadataCache.getFileCache(e);
                front = fileCache?.frontmatter || null;
                // Only cache if we got actual frontmatter data
                // Don't cache null - we'll retry on next access
                if (front !== null) {
                    this.frontmatterCache.set(cacheKey, front);
                }
            } catch {
                // Don't cache on error - allow retry
                front = null;
            }
        }

        if (!front) return;

        // Case-sensitive lookup first (most common case)
        if (Object.prototype.hasOwnProperty.call(front, t)) return front[t];

        // Case-insensitive fallback - iterate through all keys
        const lower = t.toLowerCase();
        for (let [k, v] of Object.entries(front)) {
            if (String(k).toLowerCase() === lower) return v;
        }
    }

    extractDateValue(e: TFile, t: any) {
        let n = (t.field || t.property || "").toLowerCase(),
            a = (this.app.metadataCache.getFileCache(e) || {}).frontmatter || {},
            s = (o: any) => (Array.isArray(o) ? o[0] : o),
            l;

        // Case-insensitive property lookup helper
        const getVal = (...keys: string[]) => {
            for (const key of keys) {
                // Try exact match first
                if (Object.prototype.hasOwnProperty.call(a, key)) return a[key];
                // Then case-insensitive match
                const lower = key.toLowerCase();
                for (const [k, v] of Object.entries(a)) {
                    if (String(k).toLowerCase() === lower) return v;
                }
            }
            return undefined;
        };

        return (
            n === "scheduled" || n === "start" || n === "startdate"
                ? (l = s(getVal("scheduled", "start", "start-date", "startDate")))
                : n === "due" || n === "deadline"
                    ? (l = s(getVal("due", "deadline")))
                    : n === "completed" || n === "completion"
                        ? (l = s(getVal("completed", "completion", "completion-date")))
                        : n === "created"
                            ? (l = e.stat.ctime) // fallback if not in frontmatter, but usually compared via 'created' source
                            : n === "modified"
                                ? (l = e.stat.mtime)
                                : (l = s(this.getFrontmatterValue(e, n))),
            l
        );
    }

    compareDate(e: any, t: string, n: string, r: any) {
        // Basic date ref processing
        let a = new Date();
        if (n === "today") a.setHours(0, 0, 0, 0);
        else if (n === "tomorrow")
            a.setDate(a.getDate() + 1), a.setHours(0, 0, 0, 0);
        else if (n === "yesterday")
            a.setDate(a.getDate() - 1), a.setHours(0, 0, 0, 0);
        else {
            // Try parsing relative dates like "today + 1 week"
            // This is a simplified reimplementation of the logic often found in rule-helpers or main
            // For now, assume simple date string or standard primitives.
            // If the original used detailed natural language parsing, we might need to import that helper.
            let d = Date.parse(n);
            if (!isNaN(d)) a = new Date(d);
        }

        // Parse target 'e'
        let target = e instanceof Date ? e : new Date(e);
        if (isNaN(target.getTime())) return t === "!exists" || t === "missing"; // Invalid date is effectively missing

        // Operations
        // Normalize to start of day for accurate day-granularity comparisons if needed
        // But keeping it simple for now based on standard ops
        const tVal = target.getTime();
        const rVal = a.getTime();

        if (t === "before") return tVal < rVal;
        if (t === "after") return tVal > rVal;
        if (t === "on") {
            // Strict equality might be too hard for dates with times, usually 'on' means logic day equality
            return target.toDateString() === a.toDateString();
        }
        if (t === "!on") return target.toDateString() !== a.toDateString();
        if (t === ">=") return tVal >= rVal;
        if (t === "<=") return tVal <= rVal;
        if (t === "exists") return !isNaN(tVal);
        if (t === "!exists" || t === "missing") return isNaN(tVal);

        return false;
    }

    compareValue(e: any, t: string, n: any, r: any) {
        const isEmptyVal = (val: any) => {
            if (val == null) return true;
            if (typeof val === "string") return val.trim() === "";
            return false;
        };

        if (t === "exists") return e != null && !isEmptyVal(e);
        if (t === "!exists" || t === "notexists") return e == null || isEmptyVal(e);

        // Normalize values for case-insensitive text comparisons
        const normalizeText = (val: any) =>
            val == null ? "" : `${val}`.trim().toLowerCase();

        // Numeric-aware compare (if both sides look numeric)
        const asNumber = (val: any) => {
            const num = Number(val);
            return Number.isFinite(num) ? num : null;
        };

        const s = Array.isArray(e)
            ? e.map((c) => normalizeText(c))
            : normalizeText(e);
        const l = normalizeText(n);

        if (Array.isArray(e)) {
            return e.some((o) => this.compareValue(o, t, n, r));
        }

        const numLeft = asNumber(e);
        const numRight = asNumber(n);
        const hasNumeric = numLeft !== null && numRight !== null;

        switch (t) {
            case "is":
            case "equals":
                return s === l;
            case "!is":
            case "ne":
            case "notequals":
                return s !== l;
            case ">":
            case "gt":
                return hasNumeric ? numLeft! > numRight! : s > l;
            case "<":
            case "lt":
                return hasNumeric ? numLeft! < numRight! : s < l;
            case ">=":
            case "gte":
                return hasNumeric ? numLeft! >= numRight! : s >= l;
            case "<=":
            case "lte":
                return hasNumeric ? numLeft! <= numRight! : s <= l;
            case "contains":
                return s.includes(l);
            case "!contains":
                return !s.includes(l);
            case "starts":
            case "startswith":
                return (s as any).startsWith(l);
            case "!starts":
            case "!startswith":
                return !(s as any).startsWith(l);
            case "ends":
            case "endswith":
                return (s as any).endsWith(l);
            case "!ends":
            case "!endswith":
                return !(s as any).endsWith(l);
            case "matches":
                try {
                    const flags = typeof r?.flags === "string" ? r.flags : "i";
                    const pattern = n == null ? "" : `${n}`;
                    return new RegExp(pattern, flags).test(e == null ? "" : String(e));
                } catch {
                    return !1;
                }
            default:
                return !1;
        }
    }

    private getBacklinkSourcePaths(targetFile: TFile): string[] {
        const backlinks = (this.app.metadataCache as any).getBacklinksForFile(targetFile);
        const data = backlinks?.data;
        if (!data) return [];
        if (data instanceof Map) {
            return Array.from(data.keys()).map((k) => String(k)).filter(Boolean);
        }
        if (typeof data === "object") {
            return Object.keys(data).filter(Boolean);
        }
        return [];
    }

    private extractLinkCandidates(raw: any): string[] {
        const queue = Array.isArray(raw) ? raw.slice() : [raw];
        const values: string[] = [];

        while (queue.length) {
            const item = queue.shift();
            if (Array.isArray(item)) {
                queue.push(...item);
                continue;
            }
            if (item == null) continue;
            const text = String(item).trim();
            if (!text) continue;

            const wikilinks = [...text.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map((m) => (m[1] || "").trim());
            if (wikilinks.length) {
                values.push(...wikilinks.filter(Boolean));
                continue;
            }

            if (text.includes(",")) {
                values.push(...text.split(",").map((v) => v.trim()).filter(Boolean));
                continue;
            }

            values.push(text);
        }

        return Array.from(new Set(values));
    }

    private fieldContainsLinkToTarget(sourceFile: TFile, fieldName: string, targetFile: TFile): boolean {
        const raw = this.getFrontmatterValue(sourceFile, fieldName);
        if (raw == null) return false;

        const candidates = this.extractLinkCandidates(raw);
        if (!candidates.length) return false;

        for (const candidate of candidates) {
            if (candidate === targetFile.path || candidate === targetFile.basename) return true;
            const resolved = this.app.metadataCache.getFirstLinkpathDest(candidate, sourceFile.path);
            if (resolved instanceof TFile && resolved.path === targetFile.path) return true;
        }

        return false;
    }

    evaluateFilterRule(e: any, t: any) {
        if (!t || typeof t != "object") return !1;
        if (t.type === "group" || Array.isArray(t.rules)) {
            let n = Array.isArray(t.rules) ? t.rules : [];
            if (!n.length) return false;
            let r = (t.match || "all").toLowerCase() !== "any",
                a = n.map((s) => this.evaluateFilterRule(e, s));
            return r ? a.every(Boolean) : a.some(Boolean);
        }

        if (!e) return !1;
        let n = (t.source || "frontmatter").toLowerCase(),
            r = String(t.operator || "contains").toLowerCase(),
            s = (Array.isArray(t.value) ? t.value : [t.value]).filter((v) => v !== undefined);
        if (!s.length) s = [""];

        if (n === "body") {
            if (r === "is" || r === "equals") r = "contains";
            if (r === "!is" || r === "ne" || r === "notequals") r = "!contains";
        }

        const isNegativeOperator = (op: string): boolean =>
            op.startsWith("!") || op === "ne" || op === "notequals";

        let l = (o: any) => {
            const runner = isNegativeOperator(r)
                ? (v: any) => this.compareValue(o, r, v, t)
                : (v: any) => this.compareValue(o, r, v, t);
            return isNegativeOperator(r) ? s.every(runner) : s.some(runner);
        };

        // Folder check
        let normalizedItemPath = e.path || "";
        let folderPathCandidate = e instanceof TFolder ? normalizedItemPath : (e.parent?.path || "");
        if (folderPathCandidate === "/") folderPathCandidate = ""; // Root handling

        if (n === "tag") {
            let i = (this.app.metadataCache.getFileCache(e) || {}).tags || [],
                tags = i.map((b) => String(b.tag || "").replace(/^#/, "").toLowerCase());
            // Add frontmatter tags
            let fm = (this.app.metadataCache.getFileCache(e) || {}).frontmatter || {};
            if (fm.tags) {
                if (Array.isArray(fm.tags)) {
                    tags.push(...fm.tags.map((v: any) => String(v).replace(/^#/, "").toLowerCase()));
                } else {
                    const raw = String(fm.tags);
                    const parts = raw.split(/[\s,]+/).filter(Boolean);
                    tags.push(...(parts.length > 0 ? parts : [raw]).map((v) => String(v).replace(/^#/, "").toLowerCase()));
                }
            }

            const needles = s.map(v => String(v).replace(/^#/, "").toLowerCase());
            const hasExact = needles.some((needle) => tags.some((tag) => tag === needle));
            const hasContains = needles.some((needle) => tags.some((tag) => tag.includes(needle)));
            const hasAnyTag = tags.length > 0;

            if (r === "exists") return hasAnyTag;
            if (r === "!exists" || r === "notexists") return !hasAnyTag;
            if (r === "is" || r === "equals") return hasExact;
            if (r === "!is" || r === "ne" || r === "notequals") return !hasExact;
            if (r === "contains") return hasContains;
            if (r === "!contains") return !hasContains;
            return hasContains;
        }

        if (n === "folder-filter") {
            const filterId =
                t.filterId ||
                (Array.isArray(t.value)
                    ? t.value[0]
                    : t.value) ||
                (typeof t.field === "string" ? t.field : "");
            if (!filterId) return false;
            const filterEntry = this.plugin.findFilterDefinition(filterId);
            if (!filterEntry) return false;
            const definition = filterEntry.definition || filterEntry;
            const folderTarget =
                e instanceof TFolder
                    ? e
                    : e?.parent instanceof TFolder
                        ? e.parent
                        : null;
            if (!folderTarget) return false;
            return this.evaluateFolderRuleRecursively(
                folderTarget,
                definition
            );
        }
        if (n === "folder" || n === "type") {
            return l(folderPathCandidate);
        }
        if (n === "path") return l(normalizedItemPath);
        if (n === "name") return l(e.name);
        if (n === "extension") return l((e.extension || "").toLowerCase());
        if (n === "date") {
            let i = this.extractDateValue(e, t);
            return this.compareDate(i, r, s[0], t);
        }
        if (n === "created" || n === "modified") {
            let i = n === "created" ? e.stat?.ctime : e.stat?.mtime;
            return this.compareDate(i, r, s[0], t);
        }
        if (n === "backlinks") {
            if (!(e instanceof TFile)) return false;
            const hasBacklinksFromValue = (value: any): boolean => {
                if (value == null) return false;
                if (typeof value === "number") return value > 0;
                if (Array.isArray(value)) return value.length > 0;
                if (value instanceof Set || value instanceof Map) return value.size > 0;
                if (typeof value === "object") return Object.keys(value).length > 0;
                return !!value;
            };

            const backlinkField = String(t.field || "").trim();

            let h = false;
            const backlinks = (this.app.metadataCache as any).getBacklinksForFile(e);
            const data = backlinks?.data;

            if (backlinkField) {
                const sourcePaths = this.getBacklinkSourcePaths(e);
                h = sourcePaths.some((path) => {
                    const source = this.app.vault.getAbstractFileByPath(path);
                    if (!(source instanceof TFile)) return false;
                    return this.fieldContainsLinkToTarget(source, backlinkField, e);
                });
            } else if (data instanceof Map) {
                h = Array.from(data.values()).some((value) => hasBacklinksFromValue(value));
            } else if (data && typeof data === "object") {
                h = Object.keys(data).some((key) =>
                    Object.prototype.hasOwnProperty.call(data, key) && hasBacklinksFromValue((data as any)[key])
                );
            }
            return r === "exists" ? h : r === "!exists" ? !h : !1;
        }
        if (n === "embeds") {
            let i = this.app.metadataCache.getFileCache(e) || {},
                h = (Array.isArray(i.embeds) ? i.embeds : []).length > 0;
            return r === "exists" ? h : r === "!exists" ? !h : !1;
        }
        if (n === "frontmatter" || n === "property") {
            let o = t.field || t.property || t.key,
                c = this.getFrontmatterValue(e, o);
            return l(c);
        }
        if (n === "body") {
            if (!(e instanceof TFile) || e.extension !== "md") return false;
            const rawValue = s[0];
            const normalizedValue = rawValue == null ? "" : `${rawValue}`.trim().toLowerCase();
            const taskMatch = normalizedValue.match(/^\s*[-*+]?\s*\[\s*([xX]?)\s*\]\s*$/);
            if (taskMatch && (r === "contains" || r === "!contains")) {
                const cache = this.app.metadataCache.getFileCache(e);
                const listItems = Array.isArray(cache?.listItems) ? cache!.listItems : null;
                if (listItems) {
                    const tasks = listItems.filter((item: any) => typeof item?.task === "string");
                    const wantsDone = (taskMatch[1] || "").toLowerCase() === "x";
                    const hasMatch = wantsDone
                        ? tasks.some((item: any) => (item.task || "").trim().toLowerCase() === "x")
                        : tasks.some((item: any) => (item.task || "").trim() === "");
                    return r === "!contains" ? !hasMatch : hasMatch;
                }
            }
            const content = this.getBodyContent(e);
            if (content == null) return false;
            return l(content);
        }

        if (n === "foldername") {
            if (e instanceof TFolder) return l(e.name);
            if (e instanceof TFile && e.parent) return l(e.parent.name);
            return false;
        }

        if (n === "note-count") {
            if (!(e instanceof TFolder)) return false;
            // Calculate note count recursively
            let count = 0;
            const countRecursive = (folder: TFolder) => {
                for (const child of folder.children) {
                    if (child instanceof TFile) count++;
                    else if (child instanceof TFolder) countRecursive(child);
                }
            }
            countRecursive(e);
            return this.compareValue(count, r, s[0], t);
        }

        return !1;
    }

    folderMatchesFilter(folder: TFolder, filterDefinition: any, filterId: string = ""): boolean {
        if (!folder || !filterDefinition) return false;
        const folderPath = folder.path || "/";
        const cacheKey = `${folderPath}::${filterId}`;
        const cached = this.folderFilterMatchCache.get(cacheKey);

        // We need filterMatchVersion from plugin/service if we want versioned cache
        // For now, assume version 0 or get from plugin if accessible
        const currentVersion = this.filterMatchVersion;

        if (cached && cached.version === currentVersion) {
            return cached.result;
        }

        // Evaluate full definition tree (groups + conditions), not only first rule
        const rule = filterDefinition;

        // Check if the folder ITSELF matches the rule (e.g. foldername or note-count)
        if (this.evaluateFilterRule(folder, rule)) {
            this.folderFilterMatchCache.set(cacheKey, {
                version: currentVersion,
                result: true
            });
            return true;
        }

        const result = this.evaluateFolderRuleRecursively(folder, rule);

        this.folderFilterMatchCache.set(cacheKey, {
            version: currentVersion,
            result
        });
        return result;
    }

    evaluateFolderRuleRecursively(folder: TFolder, rule: any): boolean {
        if (!folder || !rule) return false;

        // Cache check could go here if we pass the version
        // For now simple recursion logic

        // We need to iterate the folder's children
        // If ANY child matches the rule, return true.
        // Recurse into subfolders.

        const checkFile = (file: TFile) => {
            return this.evaluateFilterRule(file, rule);
        };

        const traverse = (currentFolder: TFolder): boolean => {
            const items = currentFolder.children || [];
            for (const item of items) {
                if (item instanceof TFile) {
                    if (checkFile(item)) return true;
                } else if (item instanceof TFolder) {
                    if (traverse(item)) return true;
                }
            }
            return false;
        };

        return traverse(folder);
    }

    clearCaches() {
        this.frontmatterCache.clear();
        this.folderFilterMatchCache.clear();
        this.bodyCache.clear();
        this.pendingBodyReads.clear();
        if (this.bodyRefreshTimer !== null) {
            clearTimeout(this.bodyRefreshTimer);
            this.bodyRefreshTimer = null;
        }
    }

    // Selective cache invalidation for a specific file
    invalidateFileCache(filePath: string) {
        if (!filePath) return;
        // Clear frontmatter cache for this file
        this.frontmatterCache.delete(filePath);
        this.bodyCache.delete(filePath);
        this.pendingBodyReads.delete(filePath);
        this.filterMatchVersion += 1;
    }
}
