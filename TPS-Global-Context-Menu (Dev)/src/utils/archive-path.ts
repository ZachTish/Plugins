import { TFile, normalizePath } from 'obsidian';
import type { ArchiveFolderMode } from '../types';

function getMoment(): any | null {
  return (window as any)?.moment ?? null;
}

function formatDailyBucket(date: Date): string {
  const m = getMoment();
  if (m) {
    const parsed = m(date);
    if (parsed?.isValid?.()) return parsed.format('YYYY-MM-DD');
  }
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatMonthlyBucket(date: Date): string {
  const m = getMoment();
  if (m) {
    const parsed = m(date);
    if (parsed?.isValid?.()) return parsed.format('YYYY-MM');
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatIsoWeekBucket(date: Date): string {
  const m = getMoment();
  if (m) {
    const parsed = m(date);
    if (parsed?.isValid?.()) return parsed.format('GGGG-[W]WW');
  }

  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const weekYear = utc.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

export function normalizeArchiveFolderMode(value: unknown): ArchiveFolderMode {
  return value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'none'
    ? value
    : 'none';
}

export function getArchiveBucketPath(baseArchiveFolder: string, mode: ArchiveFolderMode): string {
  const archiveRoot = normalizePath(String(baseArchiveFolder || '').trim());
  if (!archiveRoot || mode === 'none') {
    return archiveRoot;
  }

  const bucket = (() => {
    const now = new Date();
    switch (mode) {
      case 'daily':
        return formatDailyBucket(now);
      case 'weekly':
        return formatIsoWeekBucket(now);
      case 'monthly':
        return formatMonthlyBucket(now);
      default:
        return '';
    }
  })();

  return bucket ? normalizePath(`${archiveRoot}/${bucket}`) : archiveRoot;
}

export interface ArchiveTargetInfo {
  bucketPath: string;
  targetFolder: string;
  targetPath: string;
}

export function resolveArchiveTargetInfo(
  file: TFile,
  archiveBucketPath: string,
  exists: (path: string) => boolean,
): ArchiveTargetInfo {
  const bucketPath = normalizePath(String(archiveBucketPath || '').trim());
  const parentPath = normalizePath(String(file.parent?.path || '').trim());
  const targetFolder = parentPath ? normalizePath(`${bucketPath}/${parentPath}`) : bucketPath;
  const baseTarget = normalizePath(`${targetFolder}/${file.name}`);

  let targetPath = baseTarget;
  let counter = 1;
  while (exists(targetPath)) {
    targetPath = normalizePath(`${targetFolder}/${file.basename} ${counter}.${file.extension}`);
    counter += 1;
  }

  return { bucketPath, targetFolder, targetPath };
}
