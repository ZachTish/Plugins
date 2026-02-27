import { CustomProperty, CustomPropertyProfile } from './types';
import { ViewModeService } from './view-mode-service';
import * as logger from './logger';

export function resolveCustomProperties(
    properties: CustomProperty[],
    entries: any[],
    viewModeService: ViewModeService
): (CustomProperty & { disabled?: boolean; hidden?: boolean })[] {
    if (!entries || entries.length === 0) return properties;

    return properties.map(prop => {
        if (!prop.profiles || prop.profiles.length === 0) {
            return prop;
        }

        let isMixed = false;
        let firstProfileId: string | null | undefined = undefined;
        let activeProfile: CustomPropertyProfile | null = null;

        for (const entry of entries) {
            if (!entry || !entry.file) continue;
            const data = {
                path: entry.file.path,
                filePath: entry.file.path,
                ...(entry.frontmatter || {})
            };

            let matchedProfile: CustomPropertyProfile | null = null;
            for (const profile of prop.profiles) {
                if (!profile.conditions || profile.conditions.length === 0) continue;
                const matched = viewModeService.evaluateConditions(profile.match, profile.conditions, data);
                logger.log(`[Profile Resolve] ${prop.key}: profile "${profile.name}" ${matched ? 'MATCHED' : 'no match'} for path "${entry.file.path}"`);
                if (matched) {
                    matchedProfile = profile;
                    break; // first mapping wins
                }
            }

            const pId = matchedProfile ? matchedProfile.id : null;
            if (firstProfileId === undefined) {
                firstProfileId = pId;
                activeProfile = matchedProfile;
            } else if (firstProfileId !== pId) {
                isMixed = true;
            }
        }

        if (isMixed) {
            logger.log(`[Profile Resolve] ${prop.key}: mixed profiles across entries → disabled`);
            return { ...prop, disabled: true };
        }

        if (activeProfile) {
            if (activeProfile.hidden) {
                logger.log(`[Profile Resolve] ${prop.key}: profile "${activeProfile.name}" → hidden`);
                return { ...prop, hidden: true };
            }
            const resolvedOptions = activeProfile.options && activeProfile.options.length > 0 ? activeProfile.options : prop.options;
            logger.log(`[Profile Resolve] ${prop.key}: profile "${activeProfile.name}" → options: [${(resolvedOptions || []).join(', ')}]`);
            const resolved: CustomProperty & { disabled?: boolean; hidden?: boolean } = {
                ...prop,
                options: resolvedOptions
            };
            // Apply per-profile visibility overrides (only if explicitly set on profile)
            if (activeProfile.showInCollapsed !== undefined) {
                resolved.showInCollapsed = activeProfile.showInCollapsed;
            }
            if (activeProfile.showInContextMenu !== undefined) {
                resolved.showInContextMenu = activeProfile.showInContextMenu;
            }
            return resolved;
        }

        logger.log(`[Profile Resolve] ${prop.key}: no profile matched → using defaults`);
        return prop;
    }).filter(p => !p.hidden);
}
