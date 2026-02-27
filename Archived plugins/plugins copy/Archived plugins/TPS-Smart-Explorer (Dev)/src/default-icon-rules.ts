export const DEFAULT_ICON_RULES = {
    fileRules: [
        {
            id: "cSUR7",
            name: "Templates",
            match: "all",
            conditions: [
                {
                    source: "tree",
                    operator: "contains",
                    value: "Templates"
                },
                {
                    source: "tree",
                    operator: "contains",
                    value: "System"
                }
            ],
            enabled: true,
            icon: "templater-icon"
        },
        {
            id: "6tmnd",
            name: "archive",
            match: "all",
            conditions: [
                {
                    source: "tags",
                    operator: "includes",
                    value: "Archive"
                }
            ],
            enabled: true,
            icon: "lucide-archive",
            color: "purple"
        },
        {
            id: "ihKDz",
            name: "complete inbox",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "complete"
                },
                {
                    source: "tree",
                    operator: "is"
                }
            ],
            enabled: true,
            icon: "lucide-dot",
            color: "#2f482e"
        },
        {
            id: "Gn6kn",
            name: "Inbox",
            match: "all",
            conditions: [
                {
                    source: "tree",
                    operator: "!startsWith",
                    value: "0"
                },
                {
                    source: "tree",
                    operator: "!startsWith",
                    value: "system"
                },
                {
                    source: "tree",
                    operator: "!startsWith",
                    value: "99"
                }
            ],
            enabled: true,
            icon: "lucide-dot"
        },
        {
            id: "TFcXU",
            name: "no status",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "!hasValue"
                },
                {
                    source: "extension",
                    operator: "is",
                    value: "md"
                },
                {
                    source: "tree",
                    operator: "!contains",
                    value: "system"
                },
                {
                    source: "path",
                    operator: "!contains",
                    value: "03"
                }
            ],
            enabled: true,
            icon: "lucide-alert-triangle",
            color: "#f04472"
        },
        {
            id: "CGpK2",
            name: "no priority",
            match: "all",
            conditions: [
                {
                    source: "path",
                    operator: "!contains",
                    value: "system"
                },
                {
                    source: "path",
                    operator: "!contains",
                    value: "03"
                },
                {
                    source: "property:priority",
                    operator: "!hasValue"
                },
                {
                    source: "extension",
                    operator: "is",
                    value: "md"
                }
            ],
            enabled: true,
            icon: "lucide-triangle-alert",
            color: "#f04472"
        },
        {
            id: "FrgRo",
            name: "not markdown or base/canvas",
            match: "all",
            conditions: [
                {
                    source: "extension",
                    operator: "!is",
                    value: "md"
                },
                {
                    source: "extension",
                    operator: "!is",
                    value: "canvas"
                },
                {
                    source: "extension",
                    operator: "!is",
                    value: "base"
                }
            ],
            enabled: true,
            icon: "lucide-paperclip",
            color: "#8a8f98"
        },
        {
            id: "task-status-wontdo",
            name: "Task wont do",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "wont-do"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01"
                }
            ],
            enabled: true,
            icon: "lucide-x-square",
            color: "#8a8f98"
        },
        {
            id: "2s4WY",
            name: "completed Action Item",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "complete"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01"
                }
            ],
            enabled: true,
            icon: "lucide-check-square-2",
            color: "#375c44"
        },
        {
            id: "zqXer",
            name: "Active Area 02",
            match: "all",
            conditions: [
                {
                    source: "path",
                    operator: "contains",
                    value: "02 "
                },
                {
                    source: "property:status",
                    operator: "!is",
                    value: "complete"
                },
                {
                    source: "property:status",
                    operator: "!is",
                    value: "wont-do"
                },
                {
                    source: "property:status",
                    operator: "!is",
                    value: "blocked"
                }
            ],
            enabled: true,
            icon: "lucide-file-pen",
            color: "#8656ae"
        },
        {
            id: "5eFAd",
            name: "note working",
            match: "all",
            conditions: [
                {
                    source: "tree",
                    operator: "startsWith",
                    value: "02"
                },
                {
                    source: "property:status",
                    operator: "is",
                    value: "working"
                }
            ],
            enabled: true,
            icon: "lucide-notebook-pen",
            color: "purple"
        },
        {
            id: "CYurj",
            name: "complete Resource",
            match: "all",
            conditions: [
                {
                    source: "tree",
                    operator: "contains",
                    value: "02"
                },
                {
                    source: "property:status",
                    operator: "is",
                    value: "complete"
                }
            ],
            enabled: true,
            icon: "lucide-file-check",
            color: "#2f482e"
        },
        {
            id: "Dywu2",
            name: "blocked low",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "blocked"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "low"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square-minus",
            color: "#8a8f98"
        },
        {
            id: "xaUGZ",
            name: "blocked note normal",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "blocked"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "normal"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square-minus",
            color: "#478fee"
        },
        {
            id: "DyeNu",
            name: "blocked note medium",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "blocked"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "medium"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square-minus",
            color: "#e49320"
        },
        {
            id: "IusAw",
            name: "blocked note high",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "blocked"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "high"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square-minus",
            color: "#f04472"
        },
        {
            id: "t3MzH-medium",
            name: "recurring medium prio",
            match: "all",
            conditions: [
                {
                    source: "property:recurrenceRule",
                    operator: "hasValue",
                    value: "START"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "medium"
                },
                {
                    source: "property:status",
                    operator: "!is",
                    value: "complete"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square-arrow-right",
            color: "#e49320"
        },
        {
            id: "PNjsZ",
            name: "recurring high prio",
            match: "all",
            conditions: [
                {
                    source: "property:recurrenceRule",
                    operator: "hasValue",
                    value: "START"
                },
                {
                    source: "property:status",
                    operator: "!is",
                    value: "complete"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "high"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square-arrow-right",
            color: "#f04472"
        },
        {
            id: "GkUNL",
            name: "recurring normal priority",
            match: "all",
            conditions: [
                {
                    source: "property:recurrenceRule",
                    operator: "hasValue",
                    value: "START"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "normal"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square-arrow-right",
            color: "#478fee"
        },
        {
            id: "t3MzH-low",
            name: "recurring low prio",
            match: "all",
            conditions: [
                {
                    source: "property:recurrenceRule",
                    operator: "hasValue",
                    value: "START"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "low"
                },
                {
                    source: "property:status",
                    operator: "!is",
                    value: "complete"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square-arrow-right"
        },
        {
            id: "SWk8p",
            name: "started note low",
            match: "all",
            conditions: [
                {
                    source: "property:priority",
                    operator: "is",
                    value: "low"
                },
                {
                    source: "property:status",
                    operator: "is",
                    value: "working"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square",
            color: "#8a8f98"
        },
        {
            id: "O9LCD",
            name: "started note normal",
            match: "all",
            conditions: [
                {
                    source: "property:priority",
                    operator: "is",
                    value: "normal"
                },
                {
                    source: "property:status",
                    operator: "is",
                    value: "working"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square",
            color: "#478fee"
        },
        {
            id: "ezLQI",
            name: "started note medium",
            match: "all",
            conditions: [
                {
                    source: "property:priority",
                    operator: "is",
                    value: "medium"
                },
                {
                    source: "property:status",
                    operator: "is",
                    value: "working"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square",
            color: "#e49320"
        },
        {
            id: "fxkgh",
            name: "started note high",
            match: "all",
            conditions: [
                {
                    source: "property:priority",
                    operator: "is",
                    value: "high"
                },
                {
                    source: "property:status",
                    operator: "is",
                    value: "working"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-square",
            color: "#f04472"
        },
        {
            id: "xuHis",
            name: "todo open low",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "open"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "low"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-box-select",
            color: "#8a8f98"
        },
        {
            id: "GJO21",
            name: "todo open normal",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "open"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "normal"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-box-select",
            color: "#478fee"
        },
        {
            id: "5Gzl9",
            name: "todo open medium",
            match: "all",
            conditions: [
                {
                    source: "property:priority",
                    operator: "is",
                    value: "medium"
                },
                {
                    source: "property:status",
                    operator: "!is",
                    value: "complete"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-box-select",
            color: "#e49320"
        },
        {
            id: "uuSIR",
            name: "todo open high",
            match: "all",
            conditions: [
                {
                    source: "property:status",
                    operator: "is",
                    value: "open"
                },
                {
                    source: "property:priority",
                    operator: "is",
                    value: "high"
                },
                {
                    source: "path",
                    operator: "contains",
                    value: "01 Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-box-select",
            color: "#f04472"
        },
        {
            id: "VTM9c",
            name: "Dashboards",
            match: "all",
            conditions: [
                {
                    source: "tree",
                    operator: "contains",
                    value: "Dashboards"
                },
                {
                    source: "tree",
                    operator: "contains",
                    value: "03"
                }
            ],
            enabled: true,
            icon: "lucide-layout-dashboard"
        },
        {
            id: "yT1iH",
            name: "blocked note",
            match: "all",
            conditions: [
                {
                    source: "path",
                    operator: "contains",
                    value: "02"
                },
                {
                    source: "property:status",
                    operator: "is",
                    value: "blocked"
                }
            ],
            enabled: true,
            icon: "lint-ignored-file",
            color: "#5a5930"
        }
    ],
    folderRules: [
        {
            id: "aS05B",
            name: "inbox",
            match: "all",
            conditions: [
                {
                    source: "name",
                    operator: "is",
                    value: "Inbox"
                }
            ],
            enabled: true,
            icon: "lucide-inbox"
        },
        {
            id: "GWr43",
            name: "Action List",
            match: "all",
            conditions: [
                {
                    source: "tree",
                    operator: "contains",
                    value: "Action Items"
                },
                {
                    source: "name",
                    operator: "!contains",
                    value: "Action Items"
                }
            ],
            enabled: true,
            icon: "lucide-check-square"
        },
        {
            id: "bCOyn",
            name: "Resources",
            match: "all",
            conditions: [
                {
                    source: "tree",
                    operator: "contains",
                    value: "Resources"
                }
            ],
            enabled: true,
            icon: "lucide-folder-pen"
        },
        {
            id: "types-folder-icon",
            name: "Types Folder",
            match: "all",
            conditions: [
                {
                    source: "path",
                    operator: "is",
                    value: "__tps/types"
                }
            ],
            enabled: true,
            icon: "lucide-tags"
        }
    ],
    fileIcons: {},
    folderIcons: {}
};
