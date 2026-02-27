import { App, Modal, TFile } from "obsidian";
import { CalendarEntry } from "../CalendarReactView";

export class AllDayEventsModal extends Modal {
    private events: CalendarEntry[];
    private date: Date;
    private onEntryClick: (entry: CalendarEntry, isModEvent: boolean) => void;

    constructor(
        app: App,
        date: Date,
        events: CalendarEntry[],
        onEntryClick: (entry: CalendarEntry, isModEvent: boolean) => Promise<void> | void
    ) {
        super(app);
        this.date = date;
        this.events = events;
        this.onEntryClick = onEntryClick;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("all-day-events-modal");

        // Header
        const header = contentEl.createEl("h2", {
            text: this.date.toLocaleDateString(undefined, {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
            }),
        });
        header.style.marginBottom = "16px";
        header.style.borderBottom = "1px solid var(--background-modifier-border)";
        header.style.paddingBottom = "8px";

        // Event List
        const listContainer = contentEl.createDiv("all-day-events-list");
        listContainer.style.display = "flex";
        listContainer.style.flexDirection = "column";
        listContainer.style.gap = "8px";
        listContainer.style.maxHeight = "60vh";
        listContainer.style.overflowY = "auto";

        if (this.events.length === 0) {
            listContainer.createDiv({ text: "No events found." });
            return;
        }

        this.events.forEach((event) => {
            const item = listContainer.createDiv("all-day-event-item");
            item.style.padding = "8px 12px";
            item.style.borderRadius = "8px";

            // Use the event color/bg if available, simplified for list view
            const bgColor = event.backgroundColor || "var(--interactive-accent)";
            item.style.backgroundColor = "var(--background-secondary)";
            item.style.borderLeft = `4px solid ${bgColor}`;
            item.style.cursor = "pointer";
            item.style.display = "flex";
            item.style.alignItems = "center";
            item.style.justifyContent = "space-between";
            item.style.transition = "background-color 0.1s ease";

            item.onmouseover = () => {
                item.style.backgroundColor = "var(--background-modifier-hover)";
            };
            item.onmouseout = () => {
                item.style.backgroundColor = "var(--background-secondary)";
            };

            const title = item.createDiv("all-day-event-title");
            title.textContent = event.title || "Untitled";
            title.style.fontWeight = "500";
            title.style.flex = "1";

            // If it's a file, we can show a link icon or path hint? 
            // For now just the text is fine.

            item.addEventListener("click", async (e) => {
                // Close modal and navigate
                this.close();
                await this.onEntryClick(event, e.ctrlKey || e.metaKey);
            });
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
