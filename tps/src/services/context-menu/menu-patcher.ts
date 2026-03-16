import { Menu } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';

/**
 * Monkey-patches `Menu.prototype.showAtPosition` and `Menu.prototype.showAtMouseEvent`
 * so that TPS items are always injected and de-duplicated against native items right
 * before the menu is displayed.
 *
 * Returns a cleanup function that restores the original prototype methods.
 * Store the return value in `this.restoreMenuPatch` and call it in `onunload`.
 */
export function setupMenuPatch(plugin: TPSGlobalContextMenuPlugin): () => void {
    const originalShowAtPosition = Menu.prototype.showAtPosition;
    const originalShowAtMouseEvent = Menu.prototype.showAtMouseEvent;

    const maybeInjectNotebookNavigatorItems = (menu: Menu, eventTarget?: EventTarget | null) => {
        if (plugin.settings.inlineMenuOnly) return;
        if ((menu as any)._tpsHandled) return;

        const targetEl =
            eventTarget instanceof HTMLElement
                ? eventTarget
                : plugin.contextTargetService.consumeRecentContextTarget(1200);

        if (!plugin.contextTargetService.isNotebookNavigatorContextTarget(targetEl)) return;
        if (!plugin.contextTargetService.isNotebookNavigatorFileContextTarget(targetEl)) return;

        const syntheticMouseEvent = { target: targetEl } as unknown as MouseEvent;
        const targets = plugin.contextTargetService.resolveTargets([], syntheticMouseEvent, { allowActiveFileFallback: false });
        if (targets.length === 0) return;

        plugin.menuController.addToNativeMenu(menu, targets);
    };

    const reorderItems = (menu: Menu) => {
        if (!(menu as any)._tpsHandled) return;
        const items = (menu as any).items as any[] | undefined;
        if (!Array.isArray(items) || items.length === 0) return;

        const normalizeTitle = (value: string): string =>
            value
                .toLowerCase()
                .replace(/[.…]+/g, '...')
                .replace(/\s+/g, ' ')
                .trim();

        const getItemTitle = (item: any): string => {
            const direct = typeof item?.title === 'string' ? item.title : '';
            if (direct) return direct;
            const fromDom = typeof item?.dom?.textContent === 'string' ? item.dom.textContent : '';
            if (fromDom) return fromDom;
            const fromTitleEl = typeof item?.titleEl?.textContent === 'string' ? item.titleEl.textContent : '';
            if (fromTitleEl) return fromTitleEl;
            return '';
        };

        const toSemanticKey = (title: string): string | null => {
            if (!title) return null;
            let normalized = normalizeTitle(title)
                .replace(/\(\s*\d+\s+(items?|notes?|files?)\s*\)/g, '')
                .replace(/\b\d+\s+(items?|notes?|files?)\b/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (!normalized) return null;
            if (/^delete\b/.test(normalized)) return 'action:delete';
            if (/^duplicate\b/.test(normalized)) return 'action:duplicate';
            if (/^move\b.*\bto\b/.test(normalized)) return 'action:move';
            if (/^open\b.*\bnew tabs?\b/.test(normalized) || /^open in new tab\b/.test(normalized)) return 'action:open-new-tab';
            if (/^open\b.*\bto the right\b/.test(normalized)) return 'action:open-right';
            if (/^open\b.*\bnew windows?\b/.test(normalized) || /^open in new window\b/.test(normalized)) return 'action:open-new-window';
            if (/^open\b.*\bsame tab\b/.test(normalized) || /^open in same tab\b/.test(normalized)) return 'action:open-same-tab';
            return null;
        };

        const getDedupeKeys = (item: any): string[] => {
            const title = getItemTitle(item);
            if (!title) return [];
            const normalized = normalizeTitle(title);
            const keys = [`title:${normalized}`];
            const semantic = toSemanticKey(title);
            if (semantic) keys.push(semantic);
            return keys;
        };

        const tpsItems: any[] = [];
        const otherItems: any[] = [];
        for (const item of items) {
            if ((item as any)._isTpsItem) {
                tpsItems.push(item);
            } else {
                otherItems.push(item);
            }
        }

        if (tpsItems.length === 0) return;

        const preferredKeys = new Set<string>();
        for (const item of tpsItems) {
            for (const key of getDedupeKeys(item)) {
                preferredKeys.add(key);
            }
        }

        const filteredOthers = otherItems.filter((item) => {
            const keys = getDedupeKeys(item);
            if (keys.length === 0) return true;
            return !keys.some((key) => preferredKeys.has(key));
        });

        (menu as any).items = [...tpsItems, ...filteredOthers];
    };

    Menu.prototype.showAtPosition = function (pos) {
        maybeInjectNotebookNavigatorItems(this);
        reorderItems(this);
        try {
            return originalShowAtPosition.call(this, pos);
        } finally {
            plugin.contextTargetService.clearRecentContextTarget();
        }
    };

    Menu.prototype.showAtMouseEvent = function (evt) {
        maybeInjectNotebookNavigatorItems(this, evt?.target ?? null);
        reorderItems(this);
        try {
            return originalShowAtMouseEvent.call(this, evt);
        } finally {
            plugin.contextTargetService.clearRecentContextTarget();
        }
    };

    return () => {
        Menu.prototype.showAtPosition = originalShowAtPosition;
        Menu.prototype.showAtMouseEvent = originalShowAtMouseEvent;
    };
}
