"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KanbanView = exports.KANBAN_VIEW_TYPE = void 0;
const obsidian_1 = require("obsidian");
const EditCardModal_1 = require("../modals/EditCardModal");
const settings_1 = require("../settings");
exports.KANBAN_VIEW_TYPE = 'tps-kanban-view';
class KanbanView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.lanes = [];
        this.plugin = plugin;
    }
    getViewType() {
        return exports.KANBAN_VIEW_TYPE;
    }
    getDisplayText() {
        return 'TPS Kanban';
    }
    getIcon() {
        return 'list';
    }
    async onOpen() {
        this.loadState();
        this.render();
    }
    async onClose() {
        // noop
    }
    async saveState() {
        try {
            const all = await this.plugin.loadData() || {};
            const key = this.getBoardKey();
            all.boards = all.boards || {};
            all.boards[key] = this.lanes;
            await this.plugin.saveData(all);
        }
        catch (e) { /* ignore */ }
    }
    async loadState() {
        var _a, _b;
        const stored = await this.plugin.loadData() || {};
        const key = this.getBoardKey();
        if ((stored === null || stored === void 0 ? void 0 : stored.boards) && stored.boards[key]) {
            this.lanes = stored.boards[key];
        }
        else {
            const defaults = ((_b = (_a = this.plugin.settings) === null || _a === void 0 ? void 0 : _a.defaultLanes) !== null && _b !== void 0 ? _b : settings_1.DEFAULT_SETTINGS.defaultLanes);
            this.lanes = defaults.map((t, i) => ({ id: `lane_${i}`, title: t, cards: [] }));
        }
    }
    getBoardKey() {
        var _a;
        if ((_a = this.plugin.settings) === null || _a === void 0 ? void 0 : _a.perBaseScope) {
            // Use vault path + workspace layout as simple scoping key
            const vault = this.app.vault.getName ? this.app.vault.getName() : 'default';
            return `board_${vault}`;
        }
        return 'board_global';
    }
    createCardElement(card) {
        var _a;
        const cardEl = document.createElement('div');
        cardEl.className = 'tps-kanban-card';
        cardEl.textContent = card.title || ((_a = card.filePath) !== null && _a !== void 0 ? _a : 'Untitled');
        cardEl.draggable = true;
        cardEl.dataset.cardId = card.id;
        if (card.filePath)
            cardEl.title = card.filePath;
        cardEl.addEventListener('dragstart', (e) => {
            if (!e.dataTransfer)
                return;
            e.dataTransfer.effectAllowed = 'move';
            const payload = JSON.stringify({ id: card.id, title: card.title, filePath: card.filePath });
            e.dataTransfer.setData('application/x-kanban-card', payload);
            if (card.filePath) {
                e.dataTransfer.setData('obsidian/file', card.filePath);
            }
            cardEl.style.opacity = '0.5';
        });
        cardEl.addEventListener('dragend', () => {
            cardEl.style.opacity = '1';
            // save after drag
            void this.saveState();
        });
        cardEl.addEventListener('click', () => {
            // open edit modal
            const modal = new EditCardModal_1.EditCardModal(this.app, card.title, card.filePath, async (title, filePath) => {
                card.title = title;
                card.filePath = filePath;
                this.render();
                await this.saveState();
            });
            modal.open();
        });
        // context menu for card actions (edit, delete, move)
        cardEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const menu = new obsidian_1.Menu();
            menu.addItem((item) => item.setTitle('Edit').onClick(() => {
                const modal = new EditCardModal_1.EditCardModal(this.app, card.title, card.filePath, async (title, filePath) => {
                    card.title = title;
                    card.filePath = filePath;
                    this.render();
                    await this.saveState();
                });
                modal.open();
            }));
            menu.addItem((item) => item.setTitle('Delete').onClick(async () => {
                for (const l of this.lanes) {
                    const idx = l.cards.findIndex(c => c.id === card.id);
                    if (idx !== -1) {
                        l.cards.splice(idx, 1);
                        this.render();
                        await this.saveState();
                        this.app.workspace.trigger('tps-kanban-card-deleted', { cardId: card.id, laneId: l.id });
                        break;
                    }
                }
            }));
            // Move to submenu
            for (const targetLane of this.lanes) {
                menu.addItem((it) => it.setTitle(`→ ${targetLane.title}`).onClick(async () => {
                    // remove from source
                    for (const l of this.lanes) {
                        const idx = l.cards.findIndex(c => c.id === card.id);
                        if (idx !== -1) {
                            const [moved] = l.cards.splice(idx, 1);
                            const dest = this.lanes.find(x => x.id === targetLane.id);
                            dest.cards.push(moved);
                            this.render();
                            await this.saveState();
                            this.app.workspace.trigger('tps-kanban-card-moved', { cardId: card.id, from: l.id, to: dest.id });
                            return;
                        }
                    }
                }));
            }
            menu.showAtPosition({ x: e.clientX, y: e.clientY });
        });
        return cardEl;
    }
    render() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('tps-kanban-root');
        const board = container.createEl('div');
        board.addClass('tps-kanban-board');
        // Board-level drag handlers for lane reordering
        board.addEventListener('dragover', (e) => {
            if (!e.dataTransfer)
                return;
            const types = Array.from(e.dataTransfer.types || []);
            if (types.includes('application/x-kanban-lane')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            }
        });
        board.addEventListener('drop', async (e) => {
            if (!e.dataTransfer)
                return;
            const lanePayload = e.dataTransfer.getData('application/x-kanban-lane');
            if (!lanePayload)
                return;
            try {
                const draggedLaneId = lanePayload;
                // compute insert index by comparing x position
                const children = Array.from(board.children);
                let insertIndex = children.length;
                const x = e.clientX;
                for (let i = 0; i < children.length; i++) {
                    const rect = children[i].getBoundingClientRect();
                    const mid = rect.left + rect.width / 2;
                    if (x < mid) {
                        insertIndex = i;
                        break;
                    }
                }
                const srcIndex = this.lanes.findIndex(l => l.id === draggedLaneId);
                if (srcIndex === -1)
                    return;
                const [moved] = this.lanes.splice(srcIndex, 1);
                // adjust insertIndex if removing an earlier lane
                const adjustedIndex = srcIndex < insertIndex ? insertIndex - 1 : insertIndex;
                this.lanes.splice(adjustedIndex, 0, moved);
                this.render();
                await this.saveState();
                this.app.workspace.trigger('tps-kanban-lane-reordered', { laneId: moved.id, from: srcIndex, to: adjustedIndex });
            }
            catch {
                // ignore
            }
        });
        for (const lane of this.lanes) {
            const laneEl = board.createEl('div');
            laneEl.addClass('tps-kanban-lane');
            laneEl.dataset.laneId = lane.id;
            // make lane draggable for reordering
            laneEl.setAttribute('draggable', 'true');
            laneEl.addEventListener('dragstart', (e) => {
                if (!e.dataTransfer)
                    return;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/x-kanban-lane', lane.id);
                laneEl.style.opacity = '0.5';
            });
            laneEl.addEventListener('dragend', () => {
                laneEl.style.opacity = '1';
            });
            const header = laneEl.createEl('div');
            header.addClass('tps-kanban-lane-header');
            header.textContent = lane.title;
            // double-click to rename lane
            header.addEventListener('dblclick', async () => {
                const v = window.prompt('Rename lane', lane.title);
                if (v && v.trim().length > 0) {
                    lane.title = v.trim();
                    this.render();
                    await this.saveState();
                    this.app.workspace.trigger('tps-kanban-lane-renamed', { laneId: lane.id, title: lane.title });
                }
            });
            const cardsWrap = laneEl.createEl('div');
            cardsWrap.addClass('tps-kanban-cards');
            // allow drops — support inserting at specific index
            cardsWrap.addEventListener('dragover', (e) => {
                if (!e.dataTransfer)
                    return;
                const types = Array.from(e.dataTransfer.types || []);
                if (types.includes('application/x-kanban-card') || types.includes('obsidian/file') || types.includes('text/plain')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    cardsWrap.addClass('tps-kanban-drop-target');
                }
            });
            cardsWrap.addEventListener('dragleave', () => {
                cardsWrap.removeClass('tps-kanban-drop-target');
            });
            cardsWrap.addEventListener('drop', async (e) => {
                e.preventDefault();
                cardsWrap.removeClass('tps-kanban-drop-target');
                if (!e.dataTransfer)
                    return;
                // determine insert index based on pointer position
                const children = Array.from(cardsWrap.children);
                let insertIndex = children.length;
                const y = e.clientY;
                for (let i = 0; i < children.length; i++) {
                    const rect = children[i].getBoundingClientRect();
                    const mid = rect.top + rect.height / 2;
                    if (y < mid) {
                        insertIndex = i;
                        break;
                    }
                }
                const payload = e.dataTransfer.getData('application/x-kanban-card');
                if (payload) {
                    try {
                        const parsed = JSON.parse(payload);
                        // find source lane and remove
                        for (const l of this.lanes) {
                            const idx = l.cards.findIndex(c => c.id === parsed.id);
                            if (idx !== -1) {
                                const [card] = l.cards.splice(idx, 1);
                                const destLane = this.lanes.find(x => x.id === lane.id);
                                destLane.cards.splice(insertIndex, 0, card);
                                this.render();
                                await this.saveState();
                                this.app.workspace.trigger('tps-kanban-card-moved', { cardId: card.id, from: l.id, to: destLane.id });
                                return;
                            }
                        }
                    }
                    catch { /* ignore */ }
                }
                // if obsidian/file or text, create new card at insertIndex
                const filePath = e.dataTransfer.getData('obsidian/file') || e.dataTransfer.getData('text/plain');
                if (filePath) {
                    const id = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
                    const title = filePath.split('/').pop() || filePath;
                    const newCard = { id, title, filePath };
                    const destLane = this.lanes.find(x => x.id === lane.id);
                    destLane.cards.splice(insertIndex, 0, newCard);
                    this.render();
                    await this.saveState();
                    this.app.workspace.trigger('tps-kanban-card-created', { cardId: id, laneId: destLane.id });
                }
            });
            for (const card of lane.cards) {
                const cardEl = this.createCardElement(card);
                cardsWrap.appendChild(cardEl);
            }
            laneEl.appendChild(cardsWrap);
            board.appendChild(laneEl);
        }
        // controls to add lane
        const controls = container.createEl('div');
        controls.addClass('tps-kanban-controls');
        const addLaneBtn = controls.createEl('button');
        addLaneBtn.textContent = 'Add lane';
        addLaneBtn.addClass('mod-cta');
        addLaneBtn.addEventListener('click', () => {
            const id = 'lane_' + Date.now();
            this.lanes.push({ id, title: 'New Lane', cards: [] });
            this.render();
            this.saveState();
        });
    }
}
exports.KanbanView = KanbanView;
