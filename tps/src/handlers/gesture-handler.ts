/**
 * Pinch gesture detector for condense/expand view control.
 *
 * Tracks two simultaneous pointer events and fires onPinchIn (condense)
 * or onPinchOut (expand) when the inter-pointer distance changes
 * deliberately beyond the threshold.
 */

export interface PinchGestureCallbacks {
  onPinchIn: () => void;  // Fingers closing â†’ condense view
  onPinchOut: () => void; // Fingers opening  â†’ expand view
}

interface PointerPoint {
  x: number;
  y: number;
}

export class PinchGestureHandler {
  private readonly element: HTMLElement;
  private readonly callbacks: PinchGestureCallbacks;

  private readonly onPointerDownBound: (e: PointerEvent) => void;
  private readonly onPointerMoveBound: (e: PointerEvent) => void;
  private readonly onPointerUpBound: (e: PointerEvent) => void;
  private readonly onPointerCancelBound: (e: PointerEvent) => void;

  private activePointers: Map<number, PointerPoint> = new Map();
  private startDistance: number | null = null;
  private fired = false;

  /** Minimum distance change (px) before a condense/expand fires. Prevents accidental triggers. */
  private readonly minDeltaPx = 40;

  constructor(element: HTMLElement, callbacks: PinchGestureCallbacks) {
    this.element = element;
    this.callbacks = callbacks;

    this.onPointerDownBound = this.onPointerDown.bind(this);
    this.onPointerMoveBound = this.onPointerMove.bind(this);
    this.onPointerUpBound = this.onPointerUp.bind(this);
    this.onPointerCancelBound = this.onPointerCancel.bind(this);

    element.addEventListener('pointerdown', this.onPointerDownBound);
    element.addEventListener('pointermove', this.onPointerMoveBound, { passive: true });
    element.addEventListener('pointerup', this.onPointerUpBound);
    element.addEventListener('pointercancel', this.onPointerCancelBound);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getDistance(): number | null {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return null;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private onPointerDown(e: PointerEvent): void {
    this.element.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size === 2) {
      // Second finger landed â€” record starting spread
      this.startDistance = this.getDistance();
      this.fired = false;
    } else if (this.activePointers.size > 2) {
      // Three or more fingers â€” cancel to avoid misfire
      this.reset();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.activePointers.has(e.pointerId)) return;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size !== 2 || this.startDistance === null || this.fired) return;

    const current = this.getDistance();
    if (current === null) return;

    const delta = current - this.startDistance;
    if (Math.abs(delta) >= this.minDeltaPx) {
      this.fired = true;
      if (delta < 0) {
        this.callbacks.onPinchIn();  // Distance decreasing â†’ condense
      } else {
        this.callbacks.onPinchOut(); // Distance increasing â†’ expand
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) {
      this.startDistance = null;
      this.fired = false;
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    this.onPointerUp(e);
  }

  private reset(): void {
    this.activePointers.clear();
    this.startDistance = null;
    this.fired = false;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  destroy(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDownBound);
    this.element.removeEventListener('pointermove', this.onPointerMoveBound);
    this.element.removeEventListener('pointerup', this.onPointerUpBound);
    this.element.removeEventListener('pointercancel', this.onPointerCancelBound);
    this.activePointers.clear();
  }
}

