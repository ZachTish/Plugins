import {
    MarkdownPostProcessorContext,
    MarkdownRenderChild,
    TFile,
    Plugin,
    App,
    Component
} from "obsidian";
import { CalendarView } from "./calendar-view";
import { CalendarPluginBridge } from "./plugin-interface";

// Mock QueryController since we can't easily instantiate the real one without internal API access.
// We extend Component because QueryController does.
class MockQueryController extends Component {
    data: any = null;
    queryResult: any = null;
    result: any = null;

    constructor() {
        super();
    }
}

export class CalendarEmbedRenderChild extends MarkdownRenderChild {
    view: CalendarView | null = null;

    constructor(
        public containerEl: HTMLElement,
        public file: TFile,
        public plugin: Plugin & CalendarPluginBridge
    ) {
        super(containerEl);
    }

    async onload() {
        super.onload();
        this.render();
    }

    async render() {
        this.containerEl.empty();
        const contentEl = this.containerEl.createDiv({ cls: "calendar-embed-view" });

        // Create a mock controller
        const controller = new MockQueryController() as any;

        // Instantiate CalendarView
        // The constructor signature found in calendar-view.tsx is:
        // constructor(controller: QueryController, scrollEl: HTMLElement, plugin: CalendarPluginBridge)
        this.view = new CalendarView(controller, contentEl, this.plugin);

        // Manually trigger load/open if necessary
        if (this.view.onload) await this.view.onload();
        // if (this.view.onOpen) await this.view.onOpen(); // onOpen might be for actual Views, not components

        // We might need to manually inject data here if the view remains empty.
        // For now, we assume CalendarView might fetch its own data or we might need to populate the controller.
        // Since we don't have access to the query engine, this is a "best effort" attempt to get the visual component up.

        // Attempt to render
        // CalendarView likely renders React in its constructor or onload.
    }

    onunload() {
        if (this.view) {
            // this.view.onunload(); // logic to unload view
        }
        super.onunload();
    }
}

export const EmbedRenderer = (plugin: Plugin & CalendarPluginBridge) => async (
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
) => {
    const embeds = el.querySelectorAll(".internal-embed");
    embeds.forEach(async (embed) => {
        const src = embed.getAttribute("src");
        if (!src) return;

        const linkText = src.split("#")[0]; // Handle links with anchors if any
        const file = plugin.app.metadataCache.getFirstLinkpathDest(linkText, ctx.sourcePath);

        if (file && file.extension === "base") {
            // Check if it's a calendar type (optional: check frontmatter or content)
            // For now, valid .base files are assumed to be potential targets.
            // We can check metadata cache for "type: calendar" if needed.
            const cache = plugin.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter?.type === "calendar" || cache?.frontmatter?.viewType === "calendar") {
                // Valid target
            } else {
                // If type is missing, maybe default? Or skip?
                // Let's assume if it is a .base file linked, the user wants to see it.
                // But "Auto Base Embed" handles generic ones.
                // We only want to intercept if we can render it better.
                // If we are not sure, we might just proceed.
                // Let's check frontmatter strictly to avoid breaking other base views.
                if (cache?.frontmatter?.type !== "calendar") return;
            }

            // If we are here, we want to replace the default embed (which is likely broken or raw text) with our view.
            // The `embed` element is the container.
            const component = new CalendarEmbedRenderChild(embed as HTMLElement, file, plugin);
            ctx.addChild(component);
        }
    });
};
