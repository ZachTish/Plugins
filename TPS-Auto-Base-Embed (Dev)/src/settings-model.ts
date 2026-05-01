export interface BaseEmbedConditions {
  folders?: string[];
  excludeFolders?: string[];
  paths?: string[];
  excludePaths?: string[];
  tags?: string[];
  excludeTags?: string[];
  requiredStatuses?: string[];
  ignoreStatuses?: string[];
  requireTagMatchingNoteName?: boolean;
  excludeTagMatchingNoteName?: boolean;
  requireProperty?: string;
  requirePropertyEmpty?: string;
  propertyEquals?: Array<{ key: string; value: string }>;
  propertyNotEquals?: Array<{ key: string; value: string }>;
}

export type EmbedRuleKind = 'base' | 'dataviewjs';

export interface BaseEmbedRule {
  id: string;
  kind?: EmbedRuleKind;
  basePath: string;
  dataviewjsCode?: string;
  enabled: boolean;
  conditions: BaseEmbedConditions;
  initialState?: "collapsed" | "expanded" | "default";
  renderPlacement?: "floating" | "after-title" | "after-content";
}

export interface AutoBaseEmbedSettings {
  enabled: boolean;
  enableCanvasEmbeds: boolean;
  enableCanvasNodeEmbeds: boolean;
  debugLogging: boolean;
  renderMode: "floating" | "inline";
  inlinePlacement: "after-title" | "after-content";
  rules: BaseEmbedRule[];
  excludeFiles: string;
  defaultExpanded: boolean;
  accordionMode: boolean;
  alwaysExpanded: boolean;
  manualExpansionState?: Record<string, boolean>;
  basePath?: string;
  basePaths?: string;
  excludeFolders?: string;
}

export const DEFAULT_SETTINGS: AutoBaseEmbedSettings = {
  enabled: true,
  enableCanvasEmbeds: false,
  enableCanvasNodeEmbeds: false,
  debugLogging: false,
  renderMode: "floating",
  inlinePlacement: "after-content",
  rules: [],
  excludeFiles: "",
  defaultExpanded: false,
  accordionMode: false,
  alwaysExpanded: false,
  manualExpansionState: {},
};

export type RuleRenderPlacement = "floating" | "after-title" | "after-content";

export interface AutoBaseSettingsSanitizationResult {
  settings: AutoBaseEmbedSettings;
  didChange: boolean;
}

export function sanitizeAutoBaseEmbedSettings(
  raw: unknown,
  isLegacyGeneratedRule: (rule: BaseEmbedRule) => boolean,
): AutoBaseSettingsSanitizationResult {
  const settings = Object.assign({}, DEFAULT_SETTINGS, raw as Partial<AutoBaseEmbedSettings> || {});
  let didChange = false;

  if (!settings.manualExpansionState || typeof settings.manualExpansionState !== "object") {
    settings.manualExpansionState = {};
    didChange = true;
  }

  const cleanedRules = Array.isArray(settings.rules)
    ? settings.rules.filter((rule) => !isLegacyGeneratedRule(rule))
    : [];
  if (!Array.isArray(settings.rules) || cleanedRules.length !== settings.rules.length) {
    settings.rules = cleanedRules;
    didChange = true;
  }

  const legacyDefaultPlacement: RuleRenderPlacement = settings.renderMode === "inline"
    ? settings.inlinePlacement
    : "floating";
  for (const rule of settings.rules) {
    if (rule.kind !== 'base' && rule.kind !== 'dataviewjs') {
      rule.kind = 'base';
      didChange = true;
    }
    if (typeof rule.basePath !== 'string') {
      rule.basePath = '';
      didChange = true;
    }
    if (typeof rule.dataviewjsCode !== 'string') {
      rule.dataviewjsCode = '';
      didChange = true;
    }
    if (rule.renderPlacement !== "floating" && rule.renderPlacement !== "after-title" && rule.renderPlacement !== "after-content") {
      rule.renderPlacement = legacyDefaultPlacement;
      didChange = true;
    }
  }

  const hadLegacyFields =
    typeof settings.basePaths === "string" ||
    typeof settings.basePath === "string" ||
    typeof settings.excludeFolders === "string";
  if (hadLegacyFields) {
    delete settings.basePaths;
    delete settings.basePath;
    delete settings.excludeFolders;
    didChange = true;
  }

  return { settings, didChange };
}