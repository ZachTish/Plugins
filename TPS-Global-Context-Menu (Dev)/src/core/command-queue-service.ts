import type { PaneType } from "obsidian";
import { TFile } from "obsidian";

export enum OperationType {
  MOVE_FILE = "move-file",
  DELETE_FILES = "delete-files",
  OPEN_IN_NEW_CONTEXT = "open-in-new-context",
  OPEN_ACTIVE_FILE = "open-active-file",
}

export interface CommandResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: Error;
}

interface BaseOperation {
  id: string;
  type: OperationType;
}

interface OpenActiveFileOperation extends BaseOperation {
  type: OperationType.OPEN_ACTIVE_FILE;
  file: TFile;
}

interface OpenInNewContextOperation extends BaseOperation {
  type: OperationType.OPEN_IN_NEW_CONTEXT;
  file: TFile;
  context: PaneType;
}

interface MoveFileOperation extends BaseOperation {
  type: OperationType.MOVE_FILE;
  files: TFile[];
}

interface DeleteFilesOperation extends BaseOperation {
  type: OperationType.DELETE_FILES;
  files: TFile[];
}

type Operation =
  | OpenActiveFileOperation
  | OpenInNewContextOperation
  | MoveFileOperation
  | DeleteFilesOperation;

type OperationListener = (type: OperationType, active: boolean) => void;

export class CommandQueueService {
  private activeOperations = new Map<string, Operation>();
  private activeCounts = new Map<OperationType, number>();
  private listeners = new Set<OperationListener>();
  private counter = 0;

  // Active-leaf open calls are serialized so only the latest request wins.
  private openActiveFileQueue: Promise<void> = Promise.resolve();
  private latestOpenActiveFileOperationId: string | null = null;

  onOperationChange(listener: OperationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasActiveOperation(type: OperationType): boolean {
    return (this.activeCounts.get(type) ?? 0) > 0;
  }

  async executeMoveFiles(files: TFile[], performMove: () => Promise<void>): Promise<CommandResult<void>> {
    const operationId = this.generateOperationId();
    const operation: MoveFileOperation = {
      id: operationId,
      type: OperationType.MOVE_FILE,
      files,
    };

    this.beginOperation(operation);
    try {
      await performMove();
      return { success: true };
    } catch (error) {
      return { success: false, error: error as Error };
    } finally {
      this.endOperation(operation);
    }
  }

  async executeDeleteFiles(files: TFile[], performDelete: () => Promise<void>): Promise<CommandResult<void>> {
    const operationId = this.generateOperationId();
    const operation: DeleteFilesOperation = {
      id: operationId,
      type: OperationType.DELETE_FILES,
      files,
    };

    this.beginOperation(operation);
    try {
      await performDelete();
      return { success: true };
    } catch (error) {
      return { success: false, error: error as Error };
    } finally {
      this.endOperation(operation);
    }
  }

  async executeOpenInNewContext(file: TFile, context: PaneType, openFile: () => Promise<void>): Promise<CommandResult<void>> {
    const operationId = this.generateOperationId();
    const operation: OpenInNewContextOperation = {
      id: operationId,
      type: OperationType.OPEN_IN_NEW_CONTEXT,
      file,
      context,
    };

    this.beginOperation(operation);
    try {
      await openFile();
      return { success: true };
    } catch (error) {
      return { success: false, error: error as Error };
    } finally {
      this.endOperation(operation);
    }
  }

  async executeOpenActiveFile(file: TFile, openFile: () => Promise<void>): Promise<CommandResult<{ skipped: boolean }>> {
    const operationId = this.generateOperationId();
    const operation: OpenActiveFileOperation = {
      id: operationId,
      type: OperationType.OPEN_ACTIVE_FILE,
      file,
    };

    this.latestOpenActiveFileOperationId = operationId;

    const run = async (): Promise<CommandResult<{ skipped: boolean }>> => {
      if (this.latestOpenActiveFileOperationId !== operationId) {
        return { success: true, data: { skipped: true } };
      }

      this.beginOperation(operation);
      try {
        await openFile();
        if (this.latestOpenActiveFileOperationId === operationId) {
          this.latestOpenActiveFileOperationId = null;
        }
        return { success: true, data: { skipped: false } };
      } catch (error) {
        if (this.latestOpenActiveFileOperationId === operationId) {
          this.latestOpenActiveFileOperationId = null;
        }
        return { success: false, error: error as Error };
      } finally {
        this.endOperation(operation);
      }
    };

    const task = this.openActiveFileQueue.then(run, run);
    this.openActiveFileQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private generateOperationId(): string {
    this.counter += 1;
    return `op-${Date.now()}-${this.counter}`;
  }

  private beginOperation(operation: Operation): void {
    this.activeOperations.set(operation.id, operation);
    const current = this.activeCounts.get(operation.type) ?? 0;
    const next = current + 1;
    this.activeCounts.set(operation.type, next);
    if (current === 0 && next === 1) {
      this.notify(operation.type, true);
    }
  }

  private endOperation(operation: Operation): void {
    this.activeOperations.delete(operation.id);
    const current = this.activeCounts.get(operation.type) ?? 0;
    const next = Math.max(0, current - 1);
    this.activeCounts.set(operation.type, next);
    if (current > 0 && next === 0) {
      this.notify(operation.type, false);
    }
  }

  private notify(type: OperationType, active: boolean): void {
    this.listeners.forEach((listener) => {
      try {
        listener(type, active);
      } catch (error) {
        console.error("[TPS GCM] Command queue listener error", error);
      }
    });
  }
}
