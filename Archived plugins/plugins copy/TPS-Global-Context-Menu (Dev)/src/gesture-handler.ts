/**
 * Cross-platform swipe detector with direction + intent gating.
 *
 * Designed to work across touch + desktop pointer input while only firing on
 * deliberate vertical swipes. Accidental taps, clicks and mostly-horizontal
 * drags are rejected.
 */
export interface SwipeGestureCallbacks {
  onSwipeUp: () => void;
  onSwipeDown: () => void;
}

interface PointerSnapshot {
  x: number;
  y: number;
  t: number;
}

export class SwipeGestureHandler {
  private readonly element: HTMLElement;
  private readonly callbacks: SwipeGestureCallbacks;
  private readonly usePointerEvents: boolean;

  private readonly onPointerDownBound: (evt: PointerEvent) => void;
  private readonly onPointerMoveBound: (evt: PointerEvent) => void;
  private readonly onPointerUpBound: (evt: PointerEvent) => void;
  private readonly onPointerCancelBound: (evt: PointerEvent) => void;

  private readonly onTouchStartBound: (evt: TouchEvent) => void;
  private readonly onTouchMoveBound: (evt: TouchEvent) => void;
  private readonly onTouchEndBound: (evt: TouchEvent) => void;
  private readonly onTouchCancelBound: (evt: TouchEvent) => void;

  private start: PointerSnapshot | null = null;
  private last: PointerSnapshot | null = null;
  private activePointerId: number | null = null;

  // Thresholds tuned for reliable intent detection across devices.
  private readonly minVerticalDistancePx = 64;
  private readonly minVelocityPxPerMs = 0.12;
  private readonly maxGestureDurationMs = 750;
  private readonly minVerticalDominanceRatio = 1.25;
  private readonly maxDirectionSlackPx = 14;

  constructor(element: HTMLElement, callbacks: SwipeGestureCallbacks) {
    this.element = element;
    this.callbacks = callbacks;

    this.usePointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window;

    this.onPointerDownBound = this.onPointerDown.bind(this);
    this.onPointerMoveBound = this.onPointerMove.bind(this);
    this.onPointerUpBound = this.onPointerUp.bind(this);
    this.onPointerCancelBound = this.onPointerCancel.bind(this);

    this.onTouchStartBound = this.onTouchStart.bind(this);
    this.onTouchMoveBound = this.onTouchMove.bind(this);
    this.onTouchEndBound = this.onTouchEnd.bind(this);
    this.onTouchCancelBound = this.onTouchCancel.bind(this);

    if (this.usePointerEvents) {
      this.element.addEventListener('pointerdown', this.onPointerDownBound, { passive: true, capture: true });
      this.element.addEventListener('pointermove', this.onPointerMoveBound, { passive: true, capture: true });
      this.element.addEventListener('pointerup', this.onPointerUpBound, { passive: true, capture: true });
      this.element.addEventListener('pointercancel', this.onPointerCancelBound, { passive: true, capture: true });
    } else {
      this.element.addEventListener('touchstart', this.onTouchStartBound, { passive: true, capture: true });
      this.element.addEventListener('touchmove', this.onTouchMoveBound, { passive: true, capture: true });
      this.element.addEventListener('touchend', this.onTouchEndBound, { passive: true, capture: true });
      this.element.addEventListener('touchcancel', this.onTouchCancelBound, { passive: true, capture: true });
    }
  }

  destroy(): void {
    if (this.usePointerEvents) {
      this.element.removeEventListener('pointerdown', this.onPointerDownBound, true);
      this.element.removeEventListener('pointermove', this.onPointerMoveBound, true);
      this.element.removeEventListener('pointerup', this.onPointerUpBound, true);
      this.element.removeEventListener('pointercancel', this.onPointerCancelBound, true);
    } else {
      this.element.removeEventListener('touchstart', this.onTouchStartBound, true);
      this.element.removeEventListener('touchmove', this.onTouchMoveBound, true);
      this.element.removeEventListener('touchend', this.onTouchEndBound, true);
      this.element.removeEventListener('touchcancel', this.onTouchCancelBound, true);
    }

    this.activePointerId = null;
    this.start = null;
    this.last = null;
  }

  private beginTracking(x: number, y: number): void {
    const now = performance.now();
    const point = { x, y, t: now };
    this.start = point;
    this.last = point;
  }

  private updateTracking(x: number, y: number): void {
    if (!this.start) return;
    this.last = { x, y, t: performance.now() };
  }

  private clearTracking(): void {
    this.start = null;
    this.last = null;
    this.activePointerId = null;
  }

  private finalizeGesture(endX: number, endY: number, endT: number): void {
    if (!this.start) return;

    const dx = endX - this.start.x;
    const dy = endY - this.start.y;
    const dt = Math.max(1, endT - this.start.t);
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const velocityY = dy / dt;
    const absVelocityY = Math.abs(velocityY);

    this.clearTracking();

    if (absDy < this.minVerticalDistancePx) return;
    if (dt > this.maxGestureDurationMs && absVelocityY < this.minVelocityPxPerMs) return;
    if (absDy < absDx * this.minVerticalDominanceRatio) return;
    if (absDy - absDx < this.maxDirectionSlackPx) return;

    if (dy < 0) {
      this.callbacks.onSwipeUp();
      return;
    }

    this.callbacks.onSwipeDown();
  }

  private onPointerDown(evt: PointerEvent): void {
    // Left mouse button only; touch/pen accepted.
    if (evt.pointerType === 'mouse' && evt.button !== 0) {
      this.clearTracking();
      return;
    }

    // Ignore secondary pointers.
    if (!evt.isPrimary) {
      this.clearTracking();
      return;
    }

    this.activePointerId = evt.pointerId;
    this.beginTracking(evt.clientX, evt.clientY);

    if (typeof this.element.setPointerCapture === 'function') {
      try {
        this.element.setPointerCapture(evt.pointerId);
      } catch {
        // Best-effort only.
      }
    }
  }

  private onPointerMove(evt: PointerEvent): void {
    if (this.activePointerId == null || evt.pointerId !== this.activePointerId) return;
    this.updateTracking(evt.clientX, evt.clientY);
  }

  private onPointerUp(evt: PointerEvent): void {
    if (this.activePointerId == null || evt.pointerId !== this.activePointerId) return;
    const end = this.last ?? { x: evt.clientX, y: evt.clientY, t: performance.now() };
    this.finalizeGesture(end.x, end.y, end.t);
  }

  private onPointerCancel(evt: PointerEvent): void {
    if (this.activePointerId == null || evt.pointerId !== this.activePointerId) return;
    this.clearTracking();
  }

  private onTouchStart(evt: TouchEvent): void {
    if (evt.touches.length !== 1) {
      this.clearTracking();
      return;
    }

    const touch = evt.touches[0];
    if (!touch) {
      this.clearTracking();
      return;
    }

    this.beginTracking(touch.clientX, touch.clientY);
  }

  private onTouchMove(evt: TouchEvent): void {
    if (!this.start) return;

    if (evt.touches.length !== 1) {
      this.clearTracking();
      return;
    }

    const touch = evt.touches[0];
    if (!touch) return;
    this.updateTracking(touch.clientX, touch.clientY);
  }

  private onTouchEnd(evt: TouchEvent): void {
    if (!this.start) return;

    const touch = evt.changedTouches[0] ?? evt.touches[0];
    if (!touch) {
      this.clearTracking();
      return;
    }

    const end = this.last ?? { x: touch.clientX, y: touch.clientY, t: performance.now() };
    this.finalizeGesture(end.x, end.y, end.t);
  }

  private onTouchCancel(): void {
    this.clearTracking();
  }
}
