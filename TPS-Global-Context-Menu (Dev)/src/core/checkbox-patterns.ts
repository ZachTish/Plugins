import { App } from "obsidian";
import { getPluginById } from "./type-guards";

export type CheckboxStateChar = ' ' | 'x' | 'X' | '?' | '-' | '/';

export type CheckboxStatus = 'todo' | 'complete' | 'working' | 'holding' | 'wont-do';

export const DEFAULT_CHECKBOX_STATE_TO_STATUS: Record<CheckboxStateChar, CheckboxStatus> = {
    ' ': 'todo',
    'x': 'complete',
    'X': 'complete',
    '?': 'holding',
    '-': 'wont-do',
    '/': 'working',
};

export const DEFAULT_STATUS_TO_CHECKBOX_STATE: Record<string, CheckboxStateChar> = {
    todo: ' ',
    complete: 'x',
    working: '/',
    holding: '?',
    'wont-do': '-',
    wont_do: '-',
    wontdo: '-',
};

export const CHECKBOX_STATE_TO_STATUS = DEFAULT_CHECKBOX_STATE_TO_STATUS;
export const STATUS_TO_CHECKBOX_STATE = DEFAULT_STATUS_TO_CHECKBOX_STATE;

export const CHECKBOX_STATE_CHARS: CheckboxStateChar[] = [' ', 'x', 'X', '?', '-', '/'];

const STATE_CHAR_CLASS = CHECKBOX_STATE_CHARS.map((c) => {
  if (c === ' ') return ' ';
  if (c === '/') return '\\/';
  if (c === '-') return '\\-';
  return c;
}).join('');

export const CheckboxPatterns = {
    TASK_LINE: /^\s*(?:[-*+]|\d+\.)\s/,
    OPEN_CHECKBOX: /^\s*(?:[-*+]|\d+\.)\s*\[ \]/,
    CHECKBOX_WITH_STATE: new RegExp(`^\\s*(?:[-*+]|\\d+\\.)\\s*\\[([${STATE_CHAR_CLASS}])\\]`) as RegExp,
    CHECKBOX_LINE_CAPTURE: new RegExp(`^(\\s*(?:[-*+]|\\d+\\.)\\s*)\\[([${STATE_CHAR_CLASS}])\\]\\s*(.*)$`) as RegExp,
    ANY_CHECKBOX_CONTENT: /^\s*(?:[-*+]|\d+\.)\s*\[([^\]]*)\]\s+(.*)$/,
} as const;

function resolveControllerPatterns(app: App): typeof CheckboxPatterns | null {
    try {
        const controller = getPluginById(app, "tps-controller") as any;
        return controller?.api?.checkboxPatterns ?? null;
    } catch {
        return null;
    }
}

let _cachedPatterns: typeof CheckboxPatterns | null | undefined;

export function getCheckboxPatterns(app: App): typeof CheckboxPatterns {
    if (_cachedPatterns === undefined) {
        _cachedPatterns = resolveControllerPatterns(app) ?? CheckboxPatterns;
    }
    if (_cachedPatterns === null || _cachedPatterns === undefined) {
        return CheckboxPatterns;
    }
    return _cachedPatterns;
}

export function hasOpenCheckboxes(body: string): boolean {
    const lines = body.split("\n");
    return lines.some((line) => CheckboxPatterns.OPEN_CHECKBOX.test(line));
}

export function hasNoOpenCheckboxes(body: string): boolean {
    return !hasOpenCheckboxes(body);
}

function resolveSettingsMappings(app: App | null): {
    stateToStatus: Record<string, string>;
    statusToState: Record<string, string>;
} {
    const stateToStatus: Record<string, string> = { ...DEFAULT_CHECKBOX_STATE_TO_STATUS };
    const statusToState: Record<string, string> = { ...DEFAULT_STATUS_TO_CHECKBOX_STATE };

    if (!app) return { stateToStatus, statusToState };

    try {
        const gcm = getPluginById(app, "tps-global-context-menu")
            ?? (app as any)?.plugins?.plugins?.['TPS-Global-Context-Menu (Dev)'];
        const mappings = Array.isArray(gcm?.settings?.linkedSubitemCheckboxMappings)
            ? gcm.settings.linkedSubitemCheckboxMappings
            : [];

        for (const entry of mappings) {
            const bracketedState = String(entry?.checkboxState || "").trim();
            if (!bracketedState) continue;
            const innerChar = bracketedState.replace(/^\[|\]$/g, '').trim();
            if (!innerChar) continue;
            const statuses: string[] = Array.isArray(entry?.statuses) ? entry.statuses : [];
            if (!statuses.length) continue;

            stateToStatus[innerChar] = String(statuses[0]).trim().toLowerCase();

            for (const status of statuses) {
                const normalized = String(status).trim().toLowerCase().replace(/[\s-_]+/g, '');
                if (normalized) {
                    statusToState[normalized] = innerChar;
                }
            }
        }
    } catch {
        // Fall through with defaults
    }

    return { stateToStatus, statusToState };
}

export function statusForCheckboxState(state: string, app?: App | null): CheckboxStatus | null {
    if (app) {
        const { stateToStatus } = resolveSettingsMappings(app);
        const result = stateToStatus[String(state).trim()];
        if (result) return result as CheckboxStatus;
    }
    return DEFAULT_CHECKBOX_STATE_TO_STATUS[state as CheckboxStateChar] ?? null;
}

export function checkboxStateForStatus(status: string, app?: App | null): CheckboxStateChar | null {
    const normalized = String(status || '').trim().toLowerCase().replace(/[\s-_]+/g, '');
    if (app) {
        const { statusToState } = resolveSettingsMappings(app);
        const result = statusToState[normalized];
        if (result) return result as CheckboxStateChar;
    }
    return DEFAULT_STATUS_TO_CHECKBOX_STATE[normalized] ?? null;
}

export function isCompletedCheckboxState(state: string, app?: App | null): boolean {
    const status = statusForCheckboxState(state, app);
    return status === 'complete' || status === 'wont-do';
}
