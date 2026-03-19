export class ExternalCalendarService {
  async fetchEvents(): Promise<any[]> { return []; }
  async fetchEventsWithStatus(..._args: any[]): Promise<any> { return { events: [], errors: [] }; }
}
