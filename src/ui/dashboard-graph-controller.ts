import type { MeshEvent } from "../mesh/store.js";
import type { FabricProjectMeshRoute } from "./topology.js";
import { directionalGraphTarget, type FabricGraphPoint } from "./dashboard-fabric-graph.js";

/** Owns topology navigation geometry, camera physics, and replay timers. */
export class DashboardGraphController {
  private _positions = new Map<string, FabricGraphPoint>();
  private _camera: FabricGraphPoint = { x: 0, y: 0 };
  private _cameraTarget: FabricGraphPoint = { x: 0, y: 0 };
  private _velocity: FabricGraphPoint = { x: 0, y: 0 };
  private _cameraInitialized = false;
  private _animation: ReturnType<typeof setInterval> | undefined;
  private _animationAt = 0;
  private _effectsAnimation: ReturnType<typeof setInterval> | undefined;
  private _reducedMotion = false;
  private _showHistory = false;
  private _replayIndex: number | undefined;
  private _replayPlaying = false;
  private _replaySpeed = 1;
  private _replayAdvancedAt = 0;
  private _replayLength = 0;
  private _replayLabel: string | undefined;

  constructor(private readonly requestRender: () => void) {}

  togglePlayback(): void {
    this._replayPlaying = !this._replayPlaying;
    this._replayAdvancedAt = Date.now();
  }

  changeReplaySpeed(direction: number): void {
    const speeds = [0.5, 1, 2, 4];
    const current = speeds.indexOf(this._replaySpeed);
    this._replaySpeed = speeds[Math.max(0, Math.min(speeds.length - 1, current + direction))] ?? 1;
    this._replayAdvancedAt = Date.now();
  }

  toggleHistory(): void {
    this._showHistory = !this._showHistory;
  }

  toggleReducedMotion(): void {
    this._reducedMotion = !this._reducedMotion;
  }

  directionalTarget(selectedId: string | undefined, direction: "left" | "right" | "up" | "down"): string | undefined {
    return directionalGraphTarget(this._positions, selectedId, direction);
  }

  setPositions(positions: Map<string, FabricGraphPoint>): void {
    this._positions = positions;
  }

  replayFrame(events: readonly MeshEvent[], routes: readonly FabricProjectMeshRoute[]): { event: MeshEvent; route: FabricProjectMeshRoute } | undefined {
    const frames = this.replayFrames(events, routes);
    this._replayLength = frames.length;
    if (this._replayIndex !== undefined && frames.length === 0) {
      this._replayIndex = undefined;
      this._replayPlaying = false;
    } else if (this._replayIndex !== undefined) {
      this._replayIndex = Math.min(this._replayIndex, frames.length - 1);
    }
    const frame = this._replayIndex === undefined ? undefined : frames[this._replayIndex];
    this._replayLabel = frame?.event.kind;
    return frame;
  }

  get camera(): Readonly<FabricGraphPoint> { return this._camera; }
  get cameraInitialized() { return this._cameraInitialized; }
  get reducedMotion() { return this._reducedMotion; }
  get showHistory() { return this._showHistory; }
  get replayIndex() { return this._replayIndex; }
  get replayPlaying() { return this._replayPlaying; }
  get replaySpeed() { return this._replaySpeed; }
  get replayLength() { return this._replayLength; }
  get replayLabel() { return this._replayLabel; }

  private replayFrames(
    events: readonly MeshEvent[],
    routes: readonly FabricProjectMeshRoute[],
  ): Array<{ event: MeshEvent; route: FabricProjectMeshRoute }> {
    return events.flatMap((event) => {
      const route = routes.find(
        (candidate) =>
          candidate.topic === event.topic &&
          candidate.kind === event.kind &&
          (candidate.fromId === event.from.id || candidate.fromName === event.from.name),
      );
      return route ? [{ event, route }] : [];
    });
  }

  startEffectsAnimation(): void {
    if (this._effectsAnimation) return;
    this._replayAdvancedAt = Date.now();
    this._effectsAnimation = setInterval(() => {
      const now = Date.now();
      if (
        this._replayPlaying &&
        this._replayIndex !== undefined &&
        this._replayLength > 0 &&
        now - this._replayAdvancedAt >= 850 / this._replaySpeed
      ) {
        if (this._replayIndex < this._replayLength - 1) {
          this._replayIndex++;
          this._replayAdvancedAt = now;
        } else {
          this._replayPlaying = false;
        }
      }
      this.requestRender();
    }, 80);
    this._effectsAnimation.unref?.();
  }

  stopEffectsAnimation(): void {
    if (this._effectsAnimation) clearInterval(this._effectsAnimation);
    this._effectsAnimation = undefined;
    this._replayPlaying = false;
  }

  toggleReplay(events: readonly MeshEvent[], routes: readonly FabricProjectMeshRoute[]): void {
    const frames = this.replayFrames(events, routes);
    this._replayLength = frames.length;
    if (frames.length === 0) return;
    if (this._replayIndex === undefined) {
      this._replayIndex = 0;
      this._replayPlaying = true;
    } else {
      this._replayIndex = undefined;
      this._replayPlaying = false;
    }
    this._replayAdvancedAt = Date.now();
  }

  stepReplay(delta: number): void {
    if (this._replayIndex === undefined || this._replayLength === 0) return;
    this._replayIndex = Math.max(
      0,
      Math.min(this._replayLength - 1, this._replayIndex + delta),
    );
    this._replayPlaying = false;
    this._replayAdvancedAt = Date.now();
  }

  setCameraTarget(point: FabricGraphPoint): void {
    if (!this._cameraInitialized) {
      this._camera = { ...point };
      this._cameraTarget = { ...point };
      this._cameraInitialized = true;
      return;
    }
    if (this._cameraTarget.x === point.x && this._cameraTarget.y === point.y) return;
    this._cameraTarget = { ...point };
    this._animationAt = Date.now();
    if (this._animation) return;
    this._animation = setInterval(() => this.stepCamera(), 16);
    this._animation.unref?.();
  }

  stopCameraAnimation(): void {
    if (this._animation) clearInterval(this._animation);
    this._animation = undefined;
    this._animationAt = 0;
    this._velocity = { x: 0, y: 0 };
    this._cameraTarget = { ...this._camera };
  }

  private stepCamera(): void {
    const now = Date.now();
    const elapsed = this._animationAt > 0 ? (now - this._animationAt) / 1_000 : 0.016;
    const dt = Math.max(0.008, Math.min(0.032, elapsed));
    this._animationAt = now;
    const stiffness = 115;
    const damping = 19;
    const stepAxis = (position: number, target: number, velocity: number): [number, number] => {
      const acceleration = stiffness * (target - position) - damping * velocity;
      const nextVelocity = velocity + acceleration * dt;
      return [position + nextVelocity * dt, nextVelocity];
    };
    [this._camera.x, this._velocity.x] = stepAxis(
      this._camera.x,
      this._cameraTarget.x,
      this._velocity.x,
    );
    [this._camera.y, this._velocity.y] = stepAxis(
      this._camera.y,
      this._cameraTarget.y,
      this._velocity.y,
    );
    const distance = Math.hypot(
      this._cameraTarget.x - this._camera.x,
      this._cameraTarget.y - this._camera.y,
    );
    const speed = Math.hypot(this._velocity.x, this._velocity.y);
    if (distance < 0.025 && speed < 0.025) {
      this._camera = { ...this._cameraTarget };
      this._velocity = { x: 0, y: 0 };
      if (this._animation) clearInterval(this._animation);
      this._animation = undefined;
    }
    this.requestRender();
  }
}
