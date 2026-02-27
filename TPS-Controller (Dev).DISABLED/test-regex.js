function isConflictLikeBasename(basename) {
    const lower = basename.toLowerCase();
    if (lower.includes("conflict") || lower.includes("conflicted copy") || /\bcopy\b/.test(lower)) return true;
    if (/\bduplicate(\s+\d+)?$/i.test(basename.trim())) return true;
    if (/\s\([^)]+\)$/.test(basename)) return true;
    
    const trimmed = basename.trim();
    if (/\s\d{1,2}$/.test(trimmed)) {
        if (!/\d{4}-\d{2}-\d{2}(\s+\d{1,2})?$/.test(trimmed)) {
            return true;
        }
    }
    return false;
}

console.log("Catch up 2026-02-21 1:", isConflictLikeBasename("Catch up 2026-02-21 1"));
console.log("Catch up 2026-02-21-conflicted copy:", isConflictLikeBasename("Catch up 2026-02-21-conflicted copy"));
console.log("Catch up (1):", isConflictLikeBasename("Catch up (1)"));
