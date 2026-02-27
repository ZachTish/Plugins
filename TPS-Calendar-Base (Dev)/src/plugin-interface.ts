export interface CalendarPluginBridge {
  getCalendarStyleOverride(data: Record<string, any>): { color: string; textStyle: string } | null;
  getDefaultCondenseLevel(): number;
  getExternalCalendarUrls(): string[];
  getExternalCalendarFilter(): string;
  getExternalCalendarConfig(url: string): any;
  getExternalCalendarAutoCreateMap(): Record<string, any>;
  getCalendarColor(url: string): string;
  getEffectiveExternalCalendars(): any[];
  getPriorityValues(): string[];
  getStatusValues(): string[];
  settings: any;
}
