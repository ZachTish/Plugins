export interface CalendarPluginBridge {
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
