/**
 * Style Service
 *
 * Manages style profiles, builder configurations, and style assignments.
 * Handles migration of legacy style overrides into reusable profiles.
 */

import type ExplorerPlugin from "./main";
import {
  STYLE_CATEGORIES,
  createBuilderId,
  normalizeBuilderDefinition,
  normalizeServiceConfig,
  normalizeStyleProfileMap,
  normalizeStyleAssignmentEntry,
  normalizeStyleAssignments,
} from "./normalizers";

export class StyleService {
  private plugin: ExplorerPlugin;

  constructor(plugin: ExplorerPlugin) {
    this.plugin = plugin;
  }

  get settings() {
    return this.plugin.settings;
  }

  // ── Builder initialization ──────────────────────────────────────

  ensureServiceBuilders(): void {
    if (!this.settings.serviceConfig)
      this.settings.serviceConfig = normalizeServiceConfig({});
    if (!this.settings.serviceConfig.builders)
      this.settings.serviceConfig.builders = {
        sort: {
          default: normalizeBuilderDefinition({}),
          sections: {},
          filters: {},
        },
        hide: {
          default: normalizeBuilderDefinition({}),
          sections: {},
          filters: {},
        },
      };
    const o = this.settings.serviceConfig.builders;
    for (const e of ["sort", "hide", "icon", "color", "text"]) {
      if (!o[e])
        o[e] = {
          default: normalizeBuilderDefinition({}),
          sections: {},
          filters: {},
        };
      else {
        o[e].default = normalizeBuilderDefinition(o[e].default || {});
        o[e].sections = o[e].sections || {};
        o[e].filters = o[e].filters || {};
      }
      if (["icon", "color", "text", "hide"].includes(e)) {
        o[e].file = normalizeBuilderDefinition(o[e].file || {});
        o[e].folder = normalizeBuilderDefinition(o[e].folder || {});

        // One-time migration: copy default rules to file/folder if empty
        if (
          o[e].default &&
          o[e].default.rules &&
          o[e].default.rules.length > 0
        ) {
          if (
            !o[e].file._migrated &&
            (!o[e].file.rules || o[e].file.rules.length === 0)
          ) {
            const { id, ...legacyProps } = o[e].default;
            o[e].file = normalizeBuilderDefinition(
              JSON.parse(JSON.stringify(legacyProps))
            );
            o[e].file._migrated = true;
          }
          if (
            !o[e].folder._migrated &&
            (!o[e].folder.rules || o[e].folder.rules.length === 0)
          ) {
            const { id, ...legacyProps } = o[e].default;
            o[e].folder = normalizeBuilderDefinition(
              JSON.parse(JSON.stringify(legacyProps))
            );
            o[e].folder._migrated = true;
          }
        }
        if (!o[e].file._migrated) o[e].file._migrated = true;
        if (!o[e].folder._migrated) o[e].folder._migrated = true;
      }
    }
    this.ensureStyleProfiles();
  }

  // ── Style profiles ──────────────────────────────────────────────

  ensureStyleProfiles(): void {
    const cfg = this.settings.serviceConfig;
    if (!cfg.styleProfiles) cfg.styleProfiles = normalizeStyleProfileMap({});
    if (!cfg.styleAssignments)
      cfg.styleAssignments = normalizeStyleAssignments({});

    cfg.styleProfiles = normalizeStyleProfileMap(cfg.styleProfiles);
    cfg.styleAssignments = normalizeStyleAssignments(cfg.styleAssignments);

    this.migrateLegacyStyleOverrides();
  }

  migrateLegacyStyleOverrides(): void {
    const cfg = this.settings.serviceConfig;
    const builders = cfg.builders || {};

    const ensureAssignmentEntry = (target: any, key: string) => {
      if (!target[key]) target[key] = normalizeStyleAssignmentEntry({});
      target[key] = normalizeStyleAssignmentEntry(target[key]);
    };

    for (const type of STYLE_CATEGORIES) {
      if (!cfg.styleProfiles[type]) cfg.styleProfiles[type] = {};
      const profileMap = cfg.styleProfiles[type];
      const builderEntry = builders[type] || {};

      // Default profile from existing default builder
      if (builderEntry.default && !cfg.styleAssignments.default[type]) {
        const profileId = `${type}-default`;
        if (!profileMap[profileId]) {
          profileMap[profileId] = {
            id: profileId,
            name: `${type[0].toUpperCase()}${type.slice(1)} default`,
            builder: normalizeBuilderDefinition(builderEntry.default),
          };
        }
        cfg.styleAssignments.default[type] = profileId;
      }

      // Section overrides
      const sectionOverrides = builderEntry.sections || {};
      for (const sectionKey of Object.keys(sectionOverrides)) {
        const profileId = `${type}-section-${sectionKey}`;
        if (!profileMap[profileId]) {
          profileMap[profileId] = {
            id: profileId,
            name: `${sectionKey} ${type}`,
            builder: normalizeBuilderDefinition(sectionOverrides[sectionKey]),
          };
        }
        ensureAssignmentEntry(cfg.styleAssignments.sections, sectionKey);
        if (!cfg.styleAssignments.sections[sectionKey][type]) {
          cfg.styleAssignments.sections[sectionKey][type] = profileId;
        }
      }

      // Filter overrides
      const filterOverrides = builderEntry.filters || {};
      for (const filterKey of Object.keys(filterOverrides)) {
        const profileId = `${type}-filter-${filterKey}`;
        if (!profileMap[profileId]) {
          profileMap[profileId] = {
            id: profileId,
            name: `${filterKey} ${type}`,
            builder: normalizeBuilderDefinition(filterOverrides[filterKey]),
          };
        }
        ensureAssignmentEntry(cfg.styleAssignments.filters, filterKey);
        if (!cfg.styleAssignments.filters[filterKey][type]) {
          cfg.styleAssignments.filters[filterKey][type] = profileId;
        }
      }
    }
  }

  // ── Profile CRUD ────────────────────────────────────────────────

  getStyleProfiles(type: string): Record<string, any> {
    this.ensureServiceBuilders();
    return this.settings.serviceConfig.styleProfiles?.[type] || {};
  }

  getStyleProfile(type: string, profileId: string): any {
    const profiles = this.getStyleProfiles(type);
    return profiles?.[profileId] || null;
  }

  upsertStyleProfile(type: string, profile: any): any {
    if (!STYLE_CATEGORIES.includes(type)) return null;
    this.ensureServiceBuilders();
    const normalized = {
      id: profile.id || `${type}-${createBuilderId()}`,
      name: profile.name || `${type} profile`,
      builder: normalizeBuilderDefinition(profile.builder || {}),
      folderBuilder: normalizeBuilderDefinition(profile.folderBuilder || {}),
      order: profile.order ?? 9999,
    };
    if (!this.settings.serviceConfig.styleProfiles[type]) {
      this.settings.serviceConfig.styleProfiles[type] = {};
    }
    this.settings.serviceConfig.styleProfiles[type][normalized.id] = normalized;
    return normalized;
  }

  deleteStyleProfile(type: string, profileId: string): void {
    if (!STYLE_CATEGORIES.includes(type)) return;
    this.ensureServiceBuilders();
    const profiles = this.settings.serviceConfig.styleProfiles?.[type];
    if (
      profiles &&
      Object.prototype.hasOwnProperty.call(profiles, profileId)
    ) {
      delete profiles[profileId];
    }
    const assignments = this.settings.serviceConfig.styleAssignments;
    if (assignments?.default?.[type] === profileId) {
      assignments.default[type] = null;
    }
    for (const scope of ["sections", "filters"]) {
      const map = assignments?.[scope] || {};
      for (const key of Object.keys(map)) {
        if (map[key]?.[type] === profileId) {
          map[key][type] = null;
        }
      }
    }
  }

  // ── Assignments ─────────────────────────────────────────────────

  setStyleAssignment(
    scope: string,
    key: string,
    type: string,
    profileId: string | null
  ): void {
    if (!STYLE_CATEGORIES.includes(type)) return;
    this.ensureServiceBuilders();
    const assignments = this.settings.serviceConfig.styleAssignments;
    if (scope === "default") {
      assignments.default = normalizeStyleAssignmentEntry(assignments.default);
      assignments.default[type] = profileId || null;
      return;
    }
    if (!assignments[scope]) assignments[scope] = {};
    assignments[scope][key] = normalizeStyleAssignmentEntry(
      assignments[scope][key]
    );
    assignments[scope][key][type] = profileId || null;
  }

  getAssignedProfileId(type: string, context: any = {}): string | null {
    if (!STYLE_CATEGORIES.includes(type)) return null;
    this.ensureServiceBuilders();
    const assignments =
      this.settings.serviceConfig.styleAssignments || {};
    if (
      context.filterId &&
      assignments.filters?.[context.filterId]?.[type]
    ) {
      return assignments.filters[context.filterId][type];
    }
    if (
      context.sectionKey &&
      assignments.sections?.[context.sectionKey]?.[type]
    ) {
      return assignments.sections[context.sectionKey][type];
    }
    const assigned = assignments.default ? assignments.default[type] : null;
    if (assigned) return assigned;

    // Fallback: first available profile
    const profiles = this.settings.serviceConfig.styleProfiles?.[type];
    if (profiles) {
      const keys = Object.keys(profiles);
      if (keys.length > 0) return keys[0];
    }
    return null;
  }

  getProfileBuilderForContext(
    type: string,
    context: any = {}
  ): any {
    const profileId = this.getAssignedProfileId(type, context);
    if (!profileId) return null;
    const profile = this.getStyleProfile(type, profileId);
    if (!profile) return null;

    if (context.scope === "folder") {
      return normalizeBuilderDefinition(profile.folderBuilder || {});
    }
    return normalizeBuilderDefinition(profile.builder || {});
  }

  // ── Builder access ──────────────────────────────────────────────

  getVisualBuilder(type: string, scope = "default"): any {
    this.ensureServiceBuilders();
    const service = this.settings.serviceConfig.builders[type];
    if (!service) return null;

    if (scope === "file" || scope === "folder") {
      return service[scope] || service.default || null;
    }

    return service.default || null;
  }

  setVisualBuilder(type: string, builder: any, scope = "default"): void {
    this.ensureServiceBuilders();
    if (!this.settings.serviceConfig.builders[type]) {
      this.settings.serviceConfig.builders[type] = {};
    }

    if (scope === "file" || scope === "folder") {
      this.settings.serviceConfig.builders[type][scope] =
        normalizeBuilderDefinition(builder || {});
    } else {
      this.settings.serviceConfig.builders[type].default =
        normalizeBuilderDefinition(builder || {});
    }
  }

  getBuilderDefinition(type: string, context: any = {}): any {
    this.ensureServiceBuilders();
    if (STYLE_CATEGORIES.includes(type)) {
      const profileBuilder = this.getProfileBuilderForContext(type, context);
      return profileBuilder || normalizeBuilderDefinition({});
    }
    const service = this.settings.serviceConfig.builders[type];
    if (!service) return null;

    if (context.scope && ["file", "folder"].includes(context.scope)) {
      if (Object.prototype.hasOwnProperty.call(service, context.scope)) {
        return service[context.scope];
      }
      return service.default || normalizeBuilderDefinition({});
    }

    if (
      context.filterId &&
      service.filters &&
      Object.prototype.hasOwnProperty.call(service.filters, context.filterId)
    ) {
      return service.filters[context.filterId];
    }
    if (
      context.sectionKey &&
      service.sections &&
      Object.prototype.hasOwnProperty.call(
        service.sections,
        context.sectionKey
      )
    ) {
      return service.sections[context.sectionKey];
    }
    return service.default || null;
  }

  getBuilderOverride(
    type: string,
    scope: string,
    key: string
  ): any {
    this.ensureServiceBuilders();
    const service = this.settings.serviceConfig.builders[type];
    if (!service) return null;
    if (scope === "default") return service.default;
    if (
      ["file", "folder"].includes(scope) &&
      ["icon", "color", "text"].includes(type)
    ) {
      return service[scope] || null;
    }
    const map = service[scope];
    if (!map) return null;
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }

  setBuilderOverride(
    type: string,
    scope: string,
    key: string,
    builder: any
  ): void {
    this.ensureServiceBuilders();
    const service = this.settings.serviceConfig.builders[type];
    if (!service) return;
    if (scope === "default") {
      service.default = builder
        ? normalizeBuilderDefinition(builder)
        : normalizeBuilderDefinition({});
      return;
    }
    if (
      ["file", "folder"].includes(scope) &&
      ["icon", "color", "text"].includes(type)
    ) {
      service[scope] = builder
        ? normalizeBuilderDefinition(builder)
        : normalizeBuilderDefinition({});
      return;
    }
    const map = service[scope];
    if (!map) return;
    if (builder) map[key] = normalizeBuilderDefinition(builder);
    else delete map[key];
  }
}
