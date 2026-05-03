
import { requestUrl } from 'obsidian';
import * as logger from "../logger";
import { ExternalCalendarEvent } from "../types";
import { ICalParserService } from "./ical-parser-service";

export interface ExternalCalendarCacheSnapshotEntry {
  events: Array<Omit<ExternalCalendarEvent, "startDate" | "endDate"> & { startDate: string; endDate: string }>;
  expiry: number;
  updatedAt: number;
}

export type ExternalCalendarCacheSnapshot = Record<string, ExternalCalendarCacheSnapshotEntry>;

export class ExternalCalendarService {
  private cache: Map<string, { events: ExternalCalendarEvent[]; expiry: number }> = new Map();
  private inFlightFetches: Map<string, Promise<ExternalCalendarEvent[]>> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly STALE_CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days for offline display
  private readonly MAX_CACHE_ENTRIES = 200;
  private readonly FETCH_TIMEOUT_MS = 15000; // 15 seconds
  private parser: ICalParserService = new ICalParserService();

  async fetchEvents(
    calendarUrl: string,
    rangeStart?: Date,
    rangeEnd?: Date,
    includeCancelled: boolean = false,
    forceRefresh: boolean = false
  ): Promise<ExternalCalendarEvent[]> {
    const normalizedUrl = this.normalizeUrl(calendarUrl);
    if (!normalizedUrl) {
      return [];
    }

    const cacheKey = this.getCacheKey(normalizedUrl, rangeStart, rangeEnd, includeCancelled);
    const now = Date.now();
    this.pruneCache(now);

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && now < cached.expiry) {
      return cached.events;
    }

    const inFlight = this.inFlightFetches.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const fetchTask = (async (): Promise<ExternalCalendarEvent[]> => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const fetchPromise = requestUrl({
        url: normalizedUrl,
        method: 'GET',
        headers: {
          Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.8',
        },
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Fetch timed out after ${this.FETCH_TIMEOUT_MS}ms`)),
          this.FETCH_TIMEOUT_MS
        );
      });

      try {
        const response = await Promise.race([fetchPromise, timeoutPromise]);

        if (response.status !== 200) {
          logger.error('[ExternalCalendar] Failed to fetch calendar:', response.status);
          const stale = this.findCachedEventsForUrl(normalizedUrl, rangeStart, rangeEnd, includeCancelled, true);
          if (stale.length) {
            logger.warn('[ExternalCalendar] Using stale cached events after non-200 fetch response.');
            return stale;
          }
          return [];
        }

        const events = this.parser.parseICalData(response.text, rangeStart, rangeEnd, includeCancelled).map((evt) => ({
          ...evt,
          sourceUrl: normalizedUrl,
        }));

        // Cache the results
        this.cache.set(cacheKey, {
          events,
          expiry: Date.now() + this.CACHE_TTL,
        });
        this.pruneCache();

        return events;
      } catch (error) {
        logger.error('[ExternalCalendar] Error fetching calendar:', error);
        const stale = this.cache.get(cacheKey);
        if (stale?.events?.length) {
          logger.warn('[ExternalCalendar] Using stale cached events after fetch failure.');
          return stale.events;
        }
        const staleForUrl = this.findCachedEventsForUrl(normalizedUrl, rangeStart, rangeEnd, includeCancelled, true);
        if (staleForUrl.length) {
          logger.warn('[ExternalCalendar] Using stale source-scoped cached events after fetch failure.');
          return staleForUrl;
        }
        return [];
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    })();

    this.inFlightFetches.set(cacheKey, fetchTask);
    return fetchTask.finally(() => {
      this.inFlightFetches.delete(cacheKey);
    });
  }

  clearCache(): void {
    this.cache.clear();
    this.inFlightFetches.clear();
  }

  getCachedEvents(
    calendarUrl: string,
    rangeStart?: Date,
    rangeEnd?: Date,
    includeCancelled: boolean = false,
    allowExpired: boolean = true,
  ): ExternalCalendarEvent[] {
    const normalizedUrl = this.normalizeUrl(calendarUrl);
    if (!normalizedUrl) return [];
    const cacheKey = this.getCacheKey(normalizedUrl, rangeStart, rangeEnd, includeCancelled);
    const cached = this.cache.get(cacheKey);
    if (cached && (allowExpired || Date.now() < cached.expiry)) return cached.events;
    return this.findCachedEventsForUrl(normalizedUrl, rangeStart, rangeEnd, includeCancelled, allowExpired);
  }

  loadSnapshot(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== "object") return;
    const now = Date.now();
    for (const [key, entry] of Object.entries(snapshot as ExternalCalendarCacheSnapshot)) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.events)) continue;
      const updatedAt = Number((entry as any).updatedAt || 0);
      if (updatedAt && now - updatedAt > this.STALE_CACHE_TTL) continue;
      const events = entry.events
        .map((event: any) => ({
          ...event,
          startDate: new Date(event.startDate),
          endDate: new Date(event.endDate),
        }))
        .filter((event) =>
          event.startDate instanceof Date &&
          event.endDate instanceof Date &&
          !Number.isNaN(event.startDate.getTime()) &&
          !Number.isNaN(event.endDate.getTime()),
        );
      if (!events.length) continue;
      this.cache.set(key, {
        events,
        expiry: Number(entry.expiry || 0),
      });
    }
    this.pruneCache();
  }

  exportSnapshot(): ExternalCalendarCacheSnapshot {
    this.pruneCache();
    const snapshot: ExternalCalendarCacheSnapshot = {};
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      snapshot[key] = {
        expiry: entry.expiry,
        updatedAt: now,
        events: entry.events.map((event) => ({
          ...event,
          startDate: event.startDate.toISOString(),
          endDate: event.endDate.toISOString(),
        })),
      };
    }
    return snapshot;
  }

  private normalizeUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (trimmed.toLowerCase().startsWith('webcal://')) {
      return 'https://' + trimmed.slice('webcal://'.length);
    }
    return trimmed;
  }

  private getCacheKey(url: string, rangeStart?: Date, rangeEnd?: Date, includeCancelled?: boolean): string {
    const startKey = rangeStart ? rangeStart.toISOString().split('T')[0] : 'none';
    const endKey = rangeEnd ? rangeEnd.toISOString().split('T')[0] : 'none';
    return `${url}::${startKey}::${endKey}::${includeCancelled}`;
  }

  private findCachedEventsForUrl(
    normalizedUrl: string,
    rangeStart?: Date,
    rangeEnd?: Date,
    includeCancelled: boolean = false,
    allowExpired: boolean = true,
  ): ExternalCalendarEvent[] {
    const now = Date.now();
    const prefix = `${normalizedUrl}::`;
    const suffix = `::${includeCancelled}`;
    const deduped = new Map<string, ExternalCalendarEvent>();

    for (const [key, entry] of this.cache.entries()) {
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
      if (!allowExpired && now >= entry.expiry) continue;
      for (const event of entry.events || []) {
        if (!this.eventOverlapsRange(event, rangeStart, rangeEnd)) continue;
        deduped.set(`${event.sourceUrl || normalizedUrl}::${event.id}`, event);
      }
    }

    return Array.from(deduped.values()).sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }

  private eventOverlapsRange(event: ExternalCalendarEvent, rangeStart?: Date, rangeEnd?: Date): boolean {
    if (!rangeStart && !rangeEnd) return true;
    const eventStart = event.startDate?.getTime?.() ?? Number.NaN;
    const eventEnd = event.endDate?.getTime?.() ?? eventStart;
    if (!Number.isFinite(eventStart)) return false;
    const startMs = rangeStart?.getTime();
    const endMs = rangeEnd?.getTime();
    if (Number.isFinite(startMs) && eventEnd < (startMs as number)) return false;
    if (Number.isFinite(endMs) && eventStart > (endMs as number)) return false;
    return true;
  }

  private pruneCache(now = Date.now()): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiry <= now - this.STALE_CACHE_TTL) {
        this.cache.delete(key);
      }
    }

    while (this.cache.size > this.MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }
}
