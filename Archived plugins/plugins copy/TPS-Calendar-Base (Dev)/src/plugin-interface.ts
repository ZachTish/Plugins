import { AutoCreateService } from "./services/auto-create-service";

export interface CalendarPluginBridge {
  getCalendarStyleOverride(data: Record<string, any>): { color: string; textStyle: string } | null;
  getDefaultCondenseLevel(): number;
  getExternalCalendarUrls(): string[];
  getExternalCalendarFilter(): string;
  getExternalCalendarConfig(url: string): any;
  getExternalCalendarAutoCreateMap(): Record<string, any>;
  getCalendarColor(url: string): string;
  getPriorityValues(): string[];
  getStatusValues(): string[];
  isController(): boolean;
  settings: any;
  autoCreateService: AutoCreateService;
}
