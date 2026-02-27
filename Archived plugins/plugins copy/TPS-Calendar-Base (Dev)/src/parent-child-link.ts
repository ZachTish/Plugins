import { App, TFile } from "obsidian";
import * as logger from "./logger";

/**
 * Creates a bidirectional link between a child note (calendar event) and a parent note
 * @param app Obsidian app instance
 * @param childFile The child note file (calendar event)
 * @param parentFile The parent note file
 * @param parentLinkKey Frontmatter key in child pointing to parent
 * @param childLinkKey Frontmatter key in parent listing children
 */
export async function createBidirectionalLink(
    app: App,
    childFile: TFile,
    parentFile: TFile,
    parentLinkKey: string,
    childLinkKey: string
): Promise<void> {
    try {
        // Add parent link to child note
        await app.fileManager.processFrontMatter(childFile, (fm) => {
            const parentLink = `[[${parentFile.basename}]]`;
            fm[parentLinkKey] = parentLink;
            logger.log(`[ParentChildLink] Added parent link to ${childFile.path}: ${parentLinkKey} = ${parentLink}`);
        });

        // Add child link to parent note
        await app.fileManager.processFrontMatter(parentFile, (fm) => {
            const childLink = `[[${childFile.basename}]]`;

            // Get existing children
            let children: string[] = [];
            if (Array.isArray(fm[childLinkKey])) {
                children = fm[childLinkKey].map(String);
            } else if (typeof fm[childLinkKey] === 'string') {
                children = [fm[childLinkKey]];
            }

            // Add new child if not already present
            if (!children.includes(childLink)) {
                children.push(childLink);
                fm[childLinkKey] = children;
                logger.log(`[ParentChildLink] Added child link to ${parentFile.path}: ${childLinkKey} now has ${children.length} items`);
            } else {
                logger.log(`[ParentChildLink] Child link already exists in ${parentFile.path}`);
            }
        });

        logger.log(`[ParentChildLink] ✓ Bidirectional link created: ${childFile.basename} ↔ ${parentFile.basename}`);
    } catch (error) {
        logger.error(`[ParentChildLink] Failed to create bidirectional link:`, error);
        throw error;
    }
}

/**
 * Removes a bidirectional link between a child note and a parent note
 * @param app Obsidian app instance
 * @param childFile The child note file
 * @param parentFile The parent note file
 * @param parentLinkKey Frontmatter key in child pointing to parent
 * @param childLinkKey Frontmatter key in parent listing children
 */
export async function removeBidirectionalLink(
    app: App,
    childFile: TFile,
    parentFile: TFile,
    parentLinkKey: string,
    childLinkKey: string
): Promise<void> {
    try {
        // Remove parent link from child note
        await app.fileManager.processFrontMatter(childFile, (fm) => {
            if (fm[parentLinkKey]) {
                delete fm[parentLinkKey];
                logger.log(`[ParentChildLink] Removed parent link from ${childFile.path}`);
            }
        });

        // Remove child link from parent note
        await app.fileManager.processFrontMatter(parentFile, (fm) => {
            const childLink = `[[${childFile.basename}]]`;

            if (Array.isArray(fm[childLinkKey])) {
                const filtered = fm[childLinkKey].filter((link: any) => String(link) !== childLink);
                if (filtered.length > 0) {
                    fm[childLinkKey] = filtered;
                } else {
                    delete fm[childLinkKey];
                }
                logger.log(`[ParentChildLink] Removed child link from ${parentFile.path}`);
            } else if (fm[childLinkKey] === childLink) {
                delete fm[childLinkKey];
                logger.log(`[ParentChildLink] Removed child link from ${parentFile.path}`);
            }
        });

        logger.log(`[ParentChildLink] ✓ Bidirectional link removed: ${childFile.basename} ↔ ${parentFile.basename}`);
    } catch (error) {
        logger.error(`[ParentChildLink] Failed to remove bidirectional link:`, error);
        throw error;
    }
}

/**
 * Removes a child link from a parent note (used when child note is deleted)
 * @param app Obsidian app instance
 * @param childBasename The basename of the child note (without extension)
 * @param parentFile The parent note file
 * @param childLinkKey Frontmatter key in parent listing children
 */
export async function removeChildLinkFromParent(
    app: App,
    childBasename: string,
    parentFile: TFile,
    childLinkKey: string
): Promise<void> {
    try {
        await app.fileManager.processFrontMatter(parentFile, (fm) => {
            const childLink = `[[${childBasename}]]`;

            if (Array.isArray(fm[childLinkKey])) {
                const filtered = fm[childLinkKey].filter((link: any) => String(link) !== childLink);
                if (filtered.length !== fm[childLinkKey].length) {
                    if (filtered.length > 0) {
                        fm[childLinkKey] = filtered;
                    } else {
                        delete fm[childLinkKey];
                    }
                    logger.log(`[ParentChildLink] Removed detached child link '${childLink}' from ${parentFile.path}`);
                }
            } else if (fm[childLinkKey] === childLink) {
                delete fm[childLinkKey];
                logger.log(`[ParentChildLink] Removed detached child link '${childLink}' from ${parentFile.path}`);
            }
        });
    } catch (error) {
        logger.error(`[ParentChildLink] Failed to remove child link from parent:`, error);
        throw error;
    }
}
