/**
 * Notifier Feature Types
 */

export interface NotifierFeatureAPI {
    sendNotification(title: string, message: string): Promise<void>;
}
