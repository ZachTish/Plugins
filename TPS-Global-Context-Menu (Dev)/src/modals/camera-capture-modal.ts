import { App, Modal, Notice } from 'obsidian';
import * as logger from '../logger';

export class CameraCaptureModal extends Modal {
  private readonly onResolve: (value: Blob | null) => void;
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private settled = false;

  constructor(app: App, onResolve: (value: Blob | null) => void) {
    super(app);
    this.onResolve = onResolve;
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Take Photo' });

    const videoWrap = contentEl.createDiv();
    videoWrap.style.marginBottom = '12px';
    videoWrap.style.borderRadius = '8px';
    videoWrap.style.overflow = 'hidden';
    videoWrap.style.background = 'var(--background-secondary)';

    this.videoEl = videoWrap.createEl('video');
    this.videoEl.autoplay = true;
    this.videoEl.playsInline = true;
    this.videoEl.muted = true;
    this.videoEl.style.width = '100%';
    this.videoEl.style.maxHeight = '340px';
    this.videoEl.style.objectFit = 'cover';

    const actions = contentEl.createDiv();
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'flex-end';

    const cancelBtn = actions.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.finish(null);
      this.close();
    });

    const captureBtn = actions.createEl('button', { text: 'Capture', cls: 'mod-cta' });
    captureBtn.addEventListener('click', () => {
      void this.captureFrame();
    });

    void this.startStream();
  }

  onClose(): void {
    this.stopStream();
    if (!this.settled) {
      this.finish(null);
    }
    this.contentEl.empty();
  }

  private async startStream(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      new Notice('Camera access is not available on this device.');
      return;
    }

    const constraints: Array<MediaTrackConstraints | boolean> = [
      { facingMode: { ideal: 'environment' } },
      { facingMode: { ideal: 'user' } },
      true,
    ];

    for (const videoConstraint of constraints) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraint,
          audio: false,
        });
        break;
      } catch (error) {
        // Try next constraint.
      }
    }

    if (!this.stream || !this.videoEl) {
      new Notice('Unable to access camera. You can use Insert Photo to choose an image file.');
      return;
    }

    this.videoEl.srcObject = this.stream;
    try {
      await this.videoEl.play();
    } catch (error) {
      logger.warn('[TPS GCM] Video preview failed to autoplay:', error);
    }
  }

  private stopStream(): void {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) {
      track.stop();
    }
    this.stream = null;
  }

  private async captureFrame(): Promise<void> {
    if (!this.videoEl) {
      new Notice('Camera preview is not ready.');
      return;
    }

    const width = this.videoEl.videoWidth || 1280;
    const height = this.videoEl.videoHeight || 720;
    if (width <= 0 || height <= 0) {
      new Notice('Camera preview is not ready yet.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      new Notice('Unable to capture photo.');
      return;
    }

    ctx.drawImage(this.videoEl, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.92);
    });

    if (!blob) {
      new Notice('Unable to capture photo.');
      return;
    }

    this.finish(blob);
    this.close();
  }

  private finish(value: Blob | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onResolve(value);
  }
}
