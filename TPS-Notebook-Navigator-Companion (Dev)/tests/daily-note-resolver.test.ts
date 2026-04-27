import moment from "moment";
import { getDailyNoteResolver } from "../../TPS-Controller (Dev)/src/utils/daily-note-resolver";

describe("daily note resolver", () => {
  beforeEach(() => {
    (global as any).window = { moment };
  });

  it("prefers actual daily note filenames over raw daily-notes config", () => {
    const app: any = {
      plugins: {
        getPlugin: () => null,
      },
      internalPlugins: {
        getPluginById: () => ({
          instance: {
            options: {
              format: "ddd, MMM D YYYY",
              folder: "Markdown/02 Notes",
              template: "Daily Note Template",
            },
          },
        }),
      },
      vault: {
        getFiles: () => [
          {
            extension: "md",
            basename: "Friday, April 10th 2026",
            parent: { path: "Markdown/02 Notes" },
          },
        ],
      },
    };

    const resolver = getDailyNoteResolver(app);
    expect(resolver.displayFormat).toBe("dddd, MMMM Do YYYY");
    expect(resolver.parseFilenameToDateKey("Friday, April 10th 2026")).toBe("2026-04-10");
    expect(resolver.buildPath(new Date(2026, 3, 10), "md")).toBe("Markdown/02 Notes/Friday, April 10th 2026.md");
  });

  it("falls back to configured format when no daily notes exist yet", () => {
    const app: any = {
      plugins: {
        getPlugin: () => null,
      },
      internalPlugins: {
        getPluginById: () => ({
          instance: {
            options: {
              format: "YYYY-MM-DD",
              folder: "Daily",
              template: "",
            },
          },
        }),
      },
      vault: {
        getFiles: () => [],
      },
    };

    const resolver = getDailyNoteResolver(app);
    expect(resolver.displayFormat).toBe("YYYY-MM-DD");
    expect(resolver.buildPath(new Date(2026, 3, 10), "md")).toBe("Daily/2026-04-10.md");
  });
});
