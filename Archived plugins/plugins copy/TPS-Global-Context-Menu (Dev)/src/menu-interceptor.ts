import { Menu } from 'obsidian';
import * as logger from "./logger";

export class MenuInterceptor {
    menu: Menu | null = null;
    lastPosition: { x: number; y: number } | null = null;
    queuedActions: Array<() => void> = [];
    originalShow: any;
    showProxy: any;

    constructor() {
        this.originalShow = Menu.prototype.showAtPosition;
        this.showProxy = new Proxy(this.originalShow, {
            apply: (target, thisArg, args) => {
                logger.log("[TPS GCM] MenuInterceptor intercepted showAtPosition");
                this.menu = thisArg;
                this.lastPosition = args[0];

                if (this.queuedActions.length > 0) {
                    logger.log("[TPS GCM] running", this.queuedActions.length, "queued actions");
                    this.runQueuedActions();
                }

                this.moveSectionToFront(thisArg);

                const result = target.apply(thisArg, args);

                try {
                    const dom = (thisArg as any).dom;
                    if (dom) {
                        const wrapper = dom.querySelector(".tps-gcm-menu-item-wrapper");
                        if (wrapper) {
                            logger.log("[TPS GCM] forcing wrapper to top after show");
                            wrapper.remove();
                            dom.insertAdjacentElement("afterbegin", wrapper);
                        }
                    }
                } catch (e) {
                    logger.error("[TPS GCM] error forcing to top", e);
                }

                this.menu = null;
                return result;
            }
        });

        Menu.prototype.showAtPosition = this.showProxy;
    }

    queue(action: () => void) {
        if (this.menu) {
            action();
        } else {
            this.queuedActions.push(action);
        }
    }

    runQueuedActions() {
        const actions = this.queuedActions;
        this.queuedActions = [];
        actions.forEach(action => action());
    }

    moveSectionToFront(menu: Menu) {
        const sectionId = "tps-gcm";
        try {
            const items = (menu as any).items;
            if (Array.isArray(items)) {
                const tpsItems = items.filter((i: any) => i.section === sectionId);
                if (tpsItems.length > 0) {
                    const otherItems = items.filter((i: any) => i.section !== sectionId);
                    items.length = 0;
                    items.push(...tpsItems, ...otherItems);

                    const dom = (menu as any).dom;
                    if (dom) {
                        for (let i = tpsItems.length - 1; i >= 0; i--) {
                            const itemDom = tpsItems[i].dom;
                            if (itemDom instanceof HTMLElement) {
                                dom.prepend(itemDom);
                            }
                        }
                        if (tpsItems.length > 0 && otherItems.length > 0 && otherItems[0].dom) {
                            tpsItems[tpsItems.length - 1].dom.style.borderBottom = "1px solid var(--background-modifier-border)";
                        }
                    }
                }
            }

            const sections = (menu as any).sections || [];
            const idx = sections.indexOf(sectionId);
            if (idx > 0) {
                sections.splice(idx, 1);
                sections.unshift(sectionId);
            }
        } catch (e) {
            logger.warn("[TPS GCM] failed to reorder sections", e);
        }
    }

    getLastPosition() {
        return this.lastPosition;
    }

    unload() {
        if (Menu.prototype.showAtPosition === this.showProxy) {
            Menu.prototype.showAtPosition = this.originalShow;
        }
    }
}
