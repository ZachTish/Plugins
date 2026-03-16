/**
 * Controller Feature Types
 */

export interface ControllerFeatureAPI {
    getRole(): DeviceRole;
    syncCalendars(): Promise<void>;
}

export type DeviceRole = "controller" | "user" | "standalone";
