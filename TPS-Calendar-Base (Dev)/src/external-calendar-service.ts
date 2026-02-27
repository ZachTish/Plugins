
import { requestUrl } from 'obsidian';
import * as logger from "./logger";
import { ExternalCalendarEvent } from "./types";
import { ICalParserService } from "./services/ical-parser-service";

export class ExternalCalendarService {
  private cache: Map<string, { events: ExternalCalendarEvent[]; expiry: number }> = new Map();
  private inFlightFetches: Map<string, Promise<ExternalCalendarEvent[]>> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
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

  private pruneCache(now = Date.now()): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiry <= now) {
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
