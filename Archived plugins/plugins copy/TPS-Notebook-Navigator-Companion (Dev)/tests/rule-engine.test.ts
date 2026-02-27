import { RuleEngine } from "../src/services/rule-engine";
import { IconColorRule, RuleEvaluationContext, SmartSortSettings } from "../src/types";

describe("RuleEngine", () => {
  const engine = new RuleEngine();

  const baseContext: RuleEvaluationContext = {
    file: {
      path: "01 Action Items/My Task.md",
      name: "My Task.md",
      basename: "My Task",
      extension: "md"
    },
    frontmatter: {
      status: "working",
      priority: "high",
      folderPath: "wrong/path"
    },
    tags: ["work", "active"]
  };

  it("uses first matching icon and first matching color independently", () => {
    const rules: IconColorRule[] = [
      {
        id: "1",
        enabled: true,
        property: "status",
        operator: "is",
        value: "working",
        pathPrefix: "",
        icon: "lucide:clipboard-list",
        color: "",
        match: "all",
        conditions: []
      },
      {
        id: "2",
        enabled: true,
        property: "priority",
        operator: "is",
        value: "high",
        pathPrefix: "",
        icon: "",
        color: "#ff0000",
        match: "all",
        conditions: []
      },
      {
        id: "3",
        enabled: true,
        property: "status",
        operator: "is",
        value: "working",
        pathPrefix: "",
        icon: "lucide:archive",
        color: "#00ff00",
        match: "all",
        conditions: []
      }
    ];

    const resolved = engine.resolveVisualOutputs(rules, baseContext);

    expect(resolved.icon.matched).toBe(true);
    expect(resolved.icon.value).toBe("lucide:clipboard-list");
    expect(resolved.color.matched).toBe(true);
    expect(resolved.color.value).toBe("#ff0000");
  });

  it("evaluates folderPath against the real note path", () => {
    const rules: IconColorRule[] = [
      {
        id: "folder",
        enabled: true,
        property: "folderPath",
        operator: "is",
        value: "01 Action Items",
        pathPrefix: "",
        icon: "lucide:check-square-2",
        color: "",
        match: "all",
        conditions: []
      }
    ];

    const resolved = engine.resolveVisualOutputs(rules, baseContext);

    expect(resolved.icon.matched).toBe(true);
    expect(resolved.icon.value).toBe("lucide:check-square-2");
  });

  it("composes smart sort key with mapping and basename", () => {
    const settings: SmartSortSettings = {
      enabled: true,
      field: "navigator_sort",
      separator: "_",
      appendBasename: true,
      clearWhenNoMatch: false,
      segments: [
        {
          id: "seg1",
          enabled: true,
          source: "frontmatter",
          field: "priority",
          fallback: "9",
          mappings: [
            { input: "high", output: "1" },
            { input: "normal", output: "2" },
            { input: "low", output: "3" }
          ],
          match: "all",
          conditions: []
        },
        {
          id: "seg2",
          enabled: true,
          source: "path",
          field: "",
          fallback: "",
          mappings: [],
          match: "all",
          conditions: []
        }
      ]
    };

    const sortKey = engine.composeSortKey(settings, baseContext);

    expect(sortKey).toBe("1_01-Action-Items_My-Task");
  });

  it("supports advanced condition mode with any-match", () => {
    const rules: IconColorRule[] = [
      {
        id: "cond-rule",
        enabled: true,
        property: "",
        operator: "is",
        value: "",
        pathPrefix: "",
        icon: "lucide:calendar",
        color: "",
        match: "any",
        conditions: [
          {
            source: "frontmatter",
            field: "status",
            operator: "is",
            value: "complete"
          },
          {
            source: "tag",
            field: "",
            operator: "is",
            value: "active"
          }
        ]
      }
    ];

    const resolved = engine.resolveVisualOutputs(rules, baseContext);

    expect(resolved.icon.matched).toBe(true);
    expect(resolved.icon.value).toBe("lucide:calendar");
  });

  it("supports negation operators in simple mode", () => {
    const rules: IconColorRule[] = [
      {
        id: "not-complete",
        enabled: true,
        property: "status",
        operator: "!is",
        value: "complete",
        pathPrefix: "",
        icon: "lucide:circle",
        color: "",
        match: "all",
        conditions: []
      },
      {
        id: "no-z",
        enabled: true,
        property: "status",
        operator: "!contains",
        value: "zzz",
        pathPrefix: "",
        icon: "",
        color: "#33aa33",
        match: "all",
        conditions: []
      }
    ];

    const resolved = engine.resolveVisualOutputs(rules, baseContext);

    expect(resolved.icon.matched).toBe(true);
    expect(resolved.icon.value).toBe("lucide:circle");
    expect(resolved.color.matched).toBe(true);
    expect(resolved.color.value).toBe("#33aa33");
  });

  it("applies smart sort segment only when segment conditions match", () => {
    const settings: SmartSortSettings = {
      enabled: true,
      field: "navigator_sort",
      separator: "_",
      appendBasename: false,
      clearWhenNoMatch: false,
      segments: [
        {
          id: "seg-conditional",
          enabled: true,
          source: "frontmatter",
          field: "status",
          fallback: "",
          mappings: [
            { input: "working", output: "002" }
          ],
          match: "all",
          conditions: [
            {
              source: "path",
              field: "",
              operator: "contains",
              value: "01 Action Items"
            }
          ]
        },
        {
          id: "seg-always",
          enabled: true,
          source: "frontmatter",
          field: "priority",
          fallback: "",
          mappings: [
            { input: "high", output: "001" }
          ],
          match: "all",
          conditions: []
        }
      ]
    };

    const keyInMatchingPath = engine.composeSortKey(settings, baseContext);
    expect(keyInMatchingPath).toBe("002_001");

    const otherPathContext: RuleEvaluationContext = {
      ...baseContext,
      file: {
        ...baseContext.file,
        path: "02 Notes Pages/My Task.md"
      }
    };

    const keyInNonMatchingPath = engine.composeSortKey(settings, otherPathContext);
    expect(keyInNonMatchingPath).toBe("001");
  });

  it("supports advanced date window conditions for scheduled fields", () => {
    const plusDaysIso = (days: number): string => {
      return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    };

    const rule: IconColorRule = {
      id: "scheduled-window",
      enabled: true,
      property: "",
      operator: "is",
      value: "",
      pathPrefix: "",
      icon: "lucide:calendar",
      color: "",
      match: "all",
      conditions: [
        {
          source: "frontmatter",
          field: "scheduled",
          operator: "within-next-days",
          value: "7"
        }
      ]
    };

    const nearContext: RuleEvaluationContext = {
      ...baseContext,
      frontmatter: {
        ...baseContext.frontmatter,
        scheduled: plusDaysIso(3)
      }
    };
    const farContext: RuleEvaluationContext = {
      ...baseContext,
      frontmatter: {
        ...baseContext.frontmatter,
        scheduled: plusDaysIso(10)
      }
    };

    const nearResolved = engine.resolveVisualOutputs([rule], nearContext);
    const farResolved = engine.resolveVisualOutputs([rule], farContext);

    expect(nearResolved.icon.matched).toBe(true);
    expect(farResolved.icon.matched).toBe(false);
  });

  it("supports negated advanced date window conditions", () => {
    const plusDaysIso = (days: number): string => {
      return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    };

    const rule: IconColorRule = {
      id: "scheduled-window-negated",
      enabled: true,
      property: "",
      operator: "is",
      value: "",
      pathPrefix: "",
      icon: "lucide:calendar-x",
      color: "",
      match: "all",
      conditions: [
        {
          source: "frontmatter",
          field: "scheduled",
          operator: "!within-next-days",
          value: "7"
        }
      ]
    };

    const nearContext: RuleEvaluationContext = {
      ...baseContext,
      frontmatter: {
        ...baseContext.frontmatter,
        scheduled: plusDaysIso(3)
      }
    };
    const farContext: RuleEvaluationContext = {
      ...baseContext,
      frontmatter: {
        ...baseContext.frontmatter,
        scheduled: plusDaysIso(10)
      }
    };

    const nearResolved = engine.resolveVisualOutputs([rule], nearContext);
    const farResolved = engine.resolveVisualOutputs([rule], farContext);

    expect(nearResolved.icon.matched).toBe(false);
    expect(farResolved.icon.matched).toBe(true);
  });

  it("normalizes frontmatter scheduled dates into stable sort keys", () => {
    const settings: SmartSortSettings = {
      enabled: true,
      field: "navigator_sort",
      separator: "_",
      appendBasename: false,
      clearWhenNoMatch: false,
      segments: [
        {
          id: "date-segment",
          enabled: true,
          source: "frontmatter",
          field: "scheduled",
          fallback: "9999-12-31-23-59-59",
          mappings: [],
          match: "all",
          conditions: []
        }
      ]
    };

    const dateObjectContext: RuleEvaluationContext = {
      ...baseContext,
      frontmatter: {
        ...baseContext.frontmatter,
        scheduled: new Date("2026-02-12T14:45:00Z")
      }
    };

    const stringContext: RuleEvaluationContext = {
      ...baseContext,
      frontmatter: {
        ...baseContext.frontmatter,
        scheduled: "2026-12-01 09:15:00"
      }
    };

    const dateObjectKey = engine.composeSortKey(settings, dateObjectContext);
    const stringKey = engine.composeSortKey(settings, stringContext);

    expect(dateObjectKey).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
    expect(dateObjectKey).not.toContain('"');
    expect(dateObjectKey < stringKey).toBe(true);
  });

  it("uses local calendar day for date-only scheduled values", () => {
    const settings: SmartSortSettings = {
      enabled: true,
      field: "navigator_sort",
      separator: "_",
      appendBasename: false,
      clearWhenNoMatch: false,
      segments: [
        {
          id: "date-only-segment",
          enabled: true,
          source: "frontmatter",
          field: "scheduled",
          fallback: "9999-12-31-23-59-59",
          mappings: [],
          match: "all",
          conditions: []
        }
      ]
    };

    const context: RuleEvaluationContext = {
      ...baseContext,
      frontmatter: {
        ...baseContext.frontmatter,
        scheduled: "2026-02-12"
      }
    };

    const key = engine.composeSortKey(settings, context);
    expect(key).toBe("2026-02-12-00-00-00");
  });

  it("falls back to date-like basename when scheduled is empty", () => {
    const settings: SmartSortSettings = {
      enabled: true,
      field: "navigator_sort",
      separator: "_",
      appendBasename: false,
      clearWhenNoMatch: false,
      segments: [
        {
          id: "basename-date-fallback",
          enabled: true,
          source: "frontmatter",
          field: "scheduled",
          fallback: "9999-12-31-23-59-59",
          mappings: [],
          match: "all",
          conditions: []
        }
      ]
    };

    const context: RuleEvaluationContext = {
      ...baseContext,
      file: {
        ...baseContext.file,
        basename: "2026-02-09"
      },
      frontmatter: {
        ...baseContext.frontmatter,
        scheduled: ""
      }
    };

    const key = engine.composeSortKey(settings, context);
    expect(key).toBe("2026-02-09-00-00-00");
  });
});
