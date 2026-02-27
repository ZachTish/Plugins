export function getValidOperators(source: string): string[] {
    const base = [
        "is", "!is",
        "contains", "!contains",
        "exists", "!exists",
        "is-not-empty",
        "starts", "!starts"
    ];

    const dateOps = [
        "within-next-days", "!within-next-days",
        "is-today", "!is-today",
        "is-before-today", "!is-before-today",
        "is-after-today", "!is-after-today"
    ];

    if (source === "frontmatter") {
        return [
            ...base,
            ...dateOps
        ];
    }
    if (source === "name") {
        return [
            ...base,
            "is-today", "!is-today",
            "is-before-today", "!is-before-today",
            "is-after-today", "!is-after-today"
        ];
    }
    if (source === "date-created" || source === "date-modified") {
        return [
            ...base,
            ...dateOps
        ];
    }
    if (source === "body") {
        return [
            ...base,
            "has-open-checkboxes", "!has-open-checkboxes"
        ];
    }
    return base;
}
