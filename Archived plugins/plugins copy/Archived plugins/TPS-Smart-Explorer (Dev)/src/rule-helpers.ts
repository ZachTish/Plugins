export const createRuleCondition = () => ({
  type: "condition",
  source: "frontmatter",
  field: "status",
  operator: "is",
  value: "",
});

export const getRuleFieldPlaceholder = (source) => {
  switch ((source || "frontmatter").toLowerCase()) {
    case "tag":
      return "#project";
    case "folder":
      return "";
    case "path":
      return "";
    case "date":
      return "scheduled";
    case "name":
    case "extension":
      return "";
    default:
      return "status";
  }
};

export const getRuleValuePlaceholder = (source, operator) => {
  const normalized = (source || "frontmatter").toLowerCase();
  if (["date", "created", "modified"].includes(normalized)) {
    return (operator || "") === "matches" ? "YYYY-MM-DD" : "today +1 week";
  }
  if (normalized === "tag") return "project";
  if (normalized === "folder" || normalized === "path") return "01 Action Items";
  if (normalized === "name") return "My Note";
  if (normalized === "extension") return "md";
  if (normalized === "backlinks") return "parent";
  if (normalized === "embeds") return "";
  if (normalized === "body") return "- [ ]";
  return (operator || "") === "matches" ? "regex" : "value";
};

export const getRuleOperatorsForSource = (source) => {
  const normalized = (source || "").toLowerCase();
  const common = [
    { value: "is", label: "is" },
    { value: "!is", label: "is not" },
    { value: "contains", label: "contains" },
    { value: "!contains", label: "does not contain" },
    { value: "starts", label: "starts with" },
    { value: "!starts", label: "does not start with" },
    { value: "ends", label: "ends with" },
    { value: "!ends", label: "does not end with" },
    { value: "matches", label: "matches regex" },
    { value: "exists", label: "exists" },
    { value: "!exists", label: "missing" },
  ];
  if (normalized === "date") {
    return [
      { value: "before", label: "before" },
      { value: "after", label: "after" },
      { value: "on", label: "on" },
      { value: "!on", label: "not on" },
      { value: ">=", label: "on or after" },
      { value: "<=", label: "on or before" },
      { value: "exists", label: "exists" },
      { value: "!exists", label: "missing" },
    ];
  }
  if (["created", "modified"].includes(normalized)) {
    return [
      { value: "before", label: "before" },
      { value: "after", label: "after" },
      { value: "on", label: "on" },
      { value: "!on", label: "not on" },
      { value: ">=", label: "on or after" },
      { value: "<=", label: "on or before" },
      { value: "exists", label: "exists" },
      { value: "!exists", label: "missing" },
    ];
  }
  if (normalized === "backlinks") {
    return [
      { value: "exists", label: "has backlinks" },
      { value: "!exists", label: "no backlinks" },
    ];
  }
  if (normalized === "embeds") {
    return [
      { value: "exists", label: "contains embeds" },
      { value: "!exists", label: "no embeds" },
    ];
  }
  if (normalized === "tag") {
    return [
      { value: "is", label: "is" },
      { value: "!is", label: "is not" },
      { value: "contains", label: "contains" },
      { value: "!contains", label: "does not contain" },
      { value: "exists", label: "has tag" },
      { value: "!exists", label: "does not have tag" },
    ];
  }
  if (normalized === "folder") {
    return [
      { value: "is", label: "is" },
      { value: "!is", label: "is not" },
      { value: "starts", label: "starts with" },
      { value: "!starts", label: "does not start with" },
      { value: "contains", label: "contains" },
      { value: "!contains", label: "does not contain" },
    ];
  }
  if (normalized === "folder-filter") {
    return [
      { value: "contains", label: "contains files matching" },
    ];
  }
  if (normalized === "body") {
    return [
      { value: "contains", label: "contains" },
      { value: "!contains", label: "does not contain" },
      { value: "matches", label: "matches regex" },
    ];
  }
  return common;
};

export const getRuleSources = (scope?: string) => {
  // Parent scope: file-related sources for parent file rules in line filters
  if (scope === "parent") {
    return [
      { value: "frontmatter", label: "Parent Frontmatter" },
      { value: "tag", label: "Parent Tag" },
      { value: "name", label: "Parent Name" },
      { value: "folder", label: "Parent Folder" },
      { value: "path", label: "Parent Path" },
    ];
  }

  // Folder scope: only folder-relevant sources
  if (scope === "folder") {
    return [
      { value: "folder", label: "Folder" },
      { value: "foldername", label: "Folder Name" },
      { value: "note-count", label: "Note Count" },
      { value: "path", label: "Path" },
    ];
  }

  // File scope (or default): file-relevant sources
  // Excludes folder-only sources like folder-filter, note-count, foldername
  if (scope === "file") {
    return [
      { value: "frontmatter", label: "Frontmatter" },
      { value: "tag", label: "Tag" },
      { value: "name", label: "Name" },
      { value: "extension", label: "Extension" },
      { value: "folder", label: "Folder" },
      { value: "path", label: "Path" },
      { value: "body", label: "Body Content" },
      { value: "date", label: "Date" },
      { value: "created", label: "Created time" },
      { value: "modified", label: "Modified time" },
      { value: "backlinks", label: "Backlinks" },
      { value: "embeds", label: "Embeds" },
    ];
  }

  // Default: return all sources (for backwards compatibility)
  return [
    { value: "frontmatter", label: "Frontmatter" },
    { value: "tag", label: "Tag" },
    { value: "name", label: "Name" },
    { value: "extension", label: "Extension" },
    { value: "folder", label: "Folder" },
    { value: "folder-filter", label: "Recursive Filter" },
    { value: "path", label: "Path" },
    { value: "body", label: "Body Content" },
    { value: "date", label: "Date" },
    { value: "created", label: "Created time" },
    { value: "modified", label: "Modified time" },
    { value: "backlinks", label: "Backlinks" },
    { value: "embeds", label: "Embeds" },
  ];
};
