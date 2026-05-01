import type { TPSGlobalContextMenuSettings } from '../types';

export function getConfiguredPropertyKey(
  settings: TPSGlobalContextMenuSettings,
  propertyId: 'scheduled' | 'status' | 'timeEstimate',
  fallback: string,
): string {
  const configured = Array.isArray(settings.properties)
    ? settings.properties.find((prop) => String(prop?.id || '').trim().toLowerCase() === propertyId.toLowerCase())
    : null;
  return String(configured?.key || fallback).trim() || fallback;
}

export function getConfiguredTimeEstimatePropertyKey(settings: TPSGlobalContextMenuSettings): string {
  return getConfiguredPropertyKey(settings, 'timeEstimate', 'timeEstimate');
}