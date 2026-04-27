import { App, Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { EditorView } from "@codemirror/view";
import type { TPSControllerSettings } from "../types";

const TASK_REFERENCE_DRAG_TYPE = "application/x-tps-card-reference";
const TASK_REFERENCE_TEXT_PREFIX = "tps-card-reference:";
const DROP_LINK_ACTIVE_CLASS = "tps-drop-link-active";

type TaskReferenceDragPayload = {
    title: string;
    linkPath: string;
    isTask?: boolean;
    checkboxState?: string;
};

export class EditorDropLinkService {
    private activeDropEditor: HTMLElement | null = null;

    constructor(
        private readonly app: App,
        private readonly getSettings: () => TPSControllerSettings,
    ) {}

    register(plugin: Plugin): void {
        plugin.registerDomEvent(document, "dragenter", (evt) => {
            this.handleEditorDragEnter(evt);
        }, { capture: true });
        plugin.registerDomEvent(document, "dragover", (evt) => {
            this.handleEditorDragOver(evt);
        }, { capture: true });
        plugin.registerDomEvent(document, "dragleave", (evt) => {
            this.handleEditorDragLeave(evt);
        }, { capture: true });
        plugin.registerDomEvent(document, "drop", (evt) => {
            this.clearDropIndicator();
            void this.handleEditorDrop(evt);
        }, { capture: true });
        plugin.registerDomEvent(document, "dragend", () => {
            this.clearDropIndicator();
        }, { capture: true });
    }

    private isCardReferenceDrag(evt: DragEvent): boolean {
        if (!this.getSettings().editorDropLinkEnabled) return false;
        return this.hasCardReferencePayload(evt);
    }

    private handleEditorDragEnter(evt: DragEvent): void {
        if (!this.isCardReferenceDrag(evt)) return;
        const editorDom = this.findEditorDomFromTarget(evt.target);
        if (!editorDom) return;
        this.activeDropEditor = editorDom;
        editorDom.classList.add(DROP_LINK_ACTIVE_CLASS);
    }

    private handleEditorDragLeave(evt: DragEvent): void {
        if (!this.activeDropEditor) return;
        const editorDom = this.findEditorDomFromTarget(evt.target);
        if (!editorDom || !this.activeDropEditor.contains(evt.relatedTarget as Node | null)) {
            this.clearDropIndicator();
        }
    }

    private clearDropIndicator(): void {
        if (this.activeDropEditor) {
            this.activeDropEditor.classList.remove(DROP_LINK_ACTIVE_CLASS);
            this.activeDropEditor = null;
        }
    }

    private hasCardReferencePayload(evt: DragEvent): boolean {
        const transfer = evt.dataTransfer;
        if (!transfer) return false;
        if (transfer.types?.includes(TASK_REFERENCE_DRAG_TYPE)) return true;
        const plain = transfer.getData("text/plain") || "";
        if (plain.startsWith(TASK_REFERENCE_TEXT_PREFIX)) return true;
        return false;
    }

    private handleEditorDragOver(evt: DragEvent): void {
        const settings = this.getSettings();
        if (!settings.editorDropLinkEnabled) return;
        if (!this.hasCardReferencePayload(evt)) return;
        if (!this.findEditorDomFromTarget(evt.target)) return;
        evt.preventDefault();
        if (evt.dataTransfer) {
            const allowed = evt.dataTransfer.effectAllowed;
            evt.dataTransfer.dropEffect =
                allowed === "move" || allowed === "linkMove" || allowed === "copyMove"
                    ? "move"
                    : "copy";
        }
    }

    private async handleEditorDrop(evt: DragEvent): Promise<void> {
        const settings = this.getSettings();
        if (!settings.editorDropLinkEnabled) return;
        const payload = this.readPayload(evt);
        if (!payload) return;

        const editorDom = this.findEditorDomFromTarget(evt.target);
        if (!editorDom) return;

        const view = this.findMarkdownViewForElement(editorDom);
        const editor = view?.editor;
        const targetFile = this.getTargetFile(view ?? null);
        if (!editor) return;
        if (!(targetFile instanceof TFile)) return;

        const sourceFile = this.app.vault.getAbstractFileByPath(normalizePath(payload.linkPath));
        if (!(sourceFile instanceof TFile)) return;

        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation?.();

        const clientX = evt.clientX;
        const clientY = evt.clientY;
        window.requestAnimationFrame(() => {
            const inserted = payload.isTask
                ? this.insertLinkedTask(editor, targetFile, sourceFile, payload, settings, { clientX, clientY, target: editorDom } as Pick<DragEvent, "clientX" | "clientY" | "target">)
                : this.insertLinkedHeader(editor, targetFile, sourceFile, payload.title, settings, { clientX, clientY, target: editorDom } as Pick<DragEvent, "clientX" | "clientY" | "target">);
            if (!inserted) return;
            new Notice(`Inserted linked section for ${payload.title}.`, 2500);
        });
    }

    private readPayload(evt: DragEvent): TaskReferenceDragPayload | null {
        const transfer = evt.dataTransfer;
        const raw = transfer?.getData(TASK_REFERENCE_DRAG_TYPE)
            || this.extractPayloadFromPlainText(transfer?.getData("text/plain") || "");
        if (!raw) return null;

        try {
            const parsed = JSON.parse(raw) as Partial<TaskReferenceDragPayload>;
            const title = String(parsed?.title || "").trim();
            const linkPath = normalizePath(String(parsed?.linkPath || "").trim());
            if (!title || !linkPath) return null;
            return {
                title,
                linkPath,
                isTask: !!parsed?.isTask,
                checkboxState: parsed?.checkboxState || undefined,
            };
        } catch {
            return null;
        }
    }

    private extractPayloadFromPlainText(text: string): string | null {
        const value = String(text || "").trim();
        if (!value.startsWith(TASK_REFERENCE_TEXT_PREFIX)) return null;
        return value.slice(TASK_REFERENCE_TEXT_PREFIX.length).trim() || null;
    }

    private getTargetFile(info: MarkdownView | MarkdownFileInfo | null): TFile | null {
        const file = (info as MarkdownView | MarkdownFileInfo | { file?: unknown } | null)?.file;
        if (file instanceof TFile) return file;
        const activeFile = this.app.workspace.getActiveFile();
        return activeFile instanceof TFile ? activeFile : null;
    }

    private findEditorDomFromTarget(target: EventTarget | null): HTMLElement | null {
        const element =
            target instanceof HTMLElement
                ? target
                : target instanceof Node
                ? target.parentElement
                : null;
        if (!element) return null;
        return element.closest(".markdown-source-view.mod-cm6 .cm-editor, .cm-editor") as HTMLElement | null;
    }

    private findMarkdownViewForElement(element: HTMLElement): MarkdownView | null {
        let matched: MarkdownView | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (matched) return;
            const view = leaf.view;
            if (!(view instanceof MarkdownView)) return;
            const container = (view as MarkdownView & { containerEl?: HTMLElement }).containerEl;
            if (container instanceof HTMLElement && container.contains(element)) {
                matched = view;
            }
        });
        return matched;
    }

    private insertLinkedHeader(
        editor: Editor,
        targetFile: TFile,
        sourceFile: TFile,
        rawTitle: string,
        settings: TPSControllerSettings,
        dropInfo: Pick<DragEvent, "clientX" | "clientY" | "target">,
    ): boolean {
        const title = this.sanitizeLinkAlias(rawTitle);
        if (!title) return false;

        const linkText = this.app.metadataCache.fileToLinktext(sourceFile, targetFile.path, true);
        const headingLevel = Math.max(1, Math.min(6, Number(settings.editorDropLinkHeadingLevel) || 2));
        const heading = "#".repeat(headingLevel);
        const wikilink = `[[${linkText}|${title}]]`;
        const template = String(settings.editorDropLinkTemplate || "{{heading}} {{wikilink}}").trim() || "{{heading}} {{wikilink}}";
        const headerLine = template
            .replace(/\{\{heading\}\}/g, heading)
            .replace(/\{\{wikilink\}\}/g, wikilink)
            .replace(/\{\{link\}\}/g, linkText)
            .replace(/\{\{title\}\}/g, title);
        const cursor = this.getDropPosition(editor, dropInfo) || editor.getCursor("from");
        const document = editor.getValue();
        const offset = editor.posToOffset(cursor);
        const before = document.slice(Math.max(0, offset - 2), offset);
        const after = document.slice(offset, offset + 2);

        const prefix = offset === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
        const suffix = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";

        editor.replaceRange(`${prefix}${headerLine}\n${suffix}`, cursor, cursor);
        return true;
    }

    private insertLinkedTask(
        editor: Editor,
        targetFile: TFile,
        sourceFile: TFile,
        payload: TaskReferenceDragPayload,
        settings: TPSControllerSettings,
        dropInfo: Pick<DragEvent, "clientX" | "clientY" | "target">,
    ): boolean {
        const title = this.sanitizeLinkAlias(payload.title);
        if (!title) return false;

        const linkText = this.app.metadataCache.fileToLinktext(sourceFile, targetFile.path, true);
        const headingLevel = Math.max(1, Math.min(6, Number(settings.editorDropLinkHeadingLevel) || 2));
        const heading = "#".repeat(headingLevel);
        const taskLine = `${heading} [[${linkText}|${title}]]`;
        const cursor = this.getDropPosition(editor, dropInfo) || editor.getCursor("from");
        const doc = editor.getValue();
        const offset = editor.posToOffset(cursor);
        const before = doc.slice(Math.max(0, offset - 2), offset);
        const after = doc.slice(offset, offset + 2);

        const prefix = offset === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
        const suffix = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";

        editor.replaceRange(`${prefix}${taskLine}\n${suffix}`, cursor, cursor);
        return true;
    }

    private getDropPosition(editor: Editor, dropInfo: Pick<DragEvent, "clientX" | "clientY" | "target">) {
        const target = dropInfo.target;
        const targetElement =
            target instanceof HTMLElement
                ? target
                : target instanceof Node
                ? target.parentElement
                : null;
        const editorDom = (targetElement?.closest(".cm-editor") as HTMLElement | null) || null;
        if (!editorDom) return null;
        const view = EditorView.findFromDOM(editorDom);
        if (!view) return null;
        const offset = view.posAtCoords({ x: dropInfo.clientX, y: dropInfo.clientY }, false);
        if (typeof offset !== "number" || !Number.isFinite(offset)) return null;
        return editor.offsetToPos(offset);
    }

    private sanitizeLinkAlias(value: string): string {
        return String(value || "")
            .replace(/\r?\n+/g, " ")
            .replace(/\|/g, " ")
            .replace(/\]\]/g, "")
            .trim();
    }
}
