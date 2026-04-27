export const CheckboxPatterns = {
    TASK_LINE: /^\s*(?:[-*+]|\d+\.)\s/,
    OPEN_CHECKBOX: /^\s*(?:[-*+]|\d+\.)\s*\[ \]/,
    CHECKBOX_WITH_STATE: /^\s*(?:[-*+]|\d+\.)\s*\[( |x|X|\?|-|\/)\]/,
    CHECKBOX_LINE_CAPTURE: /^(\s*(?:[-*+]|\d+\.)\s*)\[( |x|X|\?|-|\/)\]\s*(.*)$/,
    ANY_CHECKBOX_CONTENT: /^\s*(?:[-*+]|\d+\.)\s*\[([^\]]*)\]\s+(.*)$/,
} as const;

export class CheckboxPatternService {
    hasOpenCheckboxes(body: string): boolean {
        const lines = body.split("\n");
        return lines.some((line) => CheckboxPatterns.OPEN_CHECKBOX.test(line));
    }

    hasNoOpenCheckboxes(body: string): boolean {
        return !this.hasOpenCheckboxes(body);
    }

    parseCheckboxLine(line: string): { prefix: string; state: string; text: string } | null {
        const match = line.match(CheckboxPatterns.CHECKBOX_LINE_CAPTURE);
        if (!match) return null;
        return { prefix: match[1], state: match[2], text: match[3] || "" };
    }

    isTaskLine(line: string): boolean {
        return CheckboxPatterns.TASK_LINE.test(line);
    }
}
