// Orchestrates compile → sandbox → instantiate → run-hooks for the host's
// authored script. Composed into `World` only on host construction.
//
// `runScript(source)` is the Run flow:
//   1. Compile new source. On failure: leave the previous instance live,
//      surface the diagnostic, do nothing else.
//   2. Tear down the previous Run's listener registrations (no-op until #5).
//   3. Instantiate the new class.
//   4. If `state.initialised === false`: invoke `onSceneInitialised(scene)`,
//      flip the flag to `true`, then `onScriptLoaded(scene)`. Otherwise:
//      `onScriptLoaded(scene)` only. Each hook is wrapped in try/catch
//      individually so an exception in one doesn't abort the rest.
//
// `loadScript({source, initialised})` is the save-file-load entrypoint —
// World invokes it after `replaceScene` populates entities. It overwrites
// the state slot then runs the same flow, so a save authored before the
// first init still fires `onSceneInitialised` exactly once on load.
//
// History undo/redo deliberately routes through `replaceScene` only and
// does NOT re-Run the script: listeners attached against entities that
// survive undo continue to work, and we don't want each undo to fire the
// hooks again.

import { compileTypescript } from './Compiler';
import { loadModule } from './Sandbox';
import { Game } from './Game';
import { SceneFacade } from './SceneFacade';
import { type ScriptRunContext } from './EntityFacade';
import { type BagOps } from './BagFacade';
import { ScriptErrorLog } from './ScriptErrorLog';
import { makeCapturingConsole, wrapOneShotSource, formatArg, type LogLine } from './ConsoleSandbox';
import { type EntityScene } from '../entity/EntityComponent';
import { type AssetEntry, type AssetType } from '../assets/Manifest';
import { type StickerOpts } from '../entity/components/attachSticker';
import { type TurnsBridge } from './TurnsBridge';
import { type TurnEvent } from '../seats/TurnTracker';
import { type SeatIndex } from '../seats/SeatLayout';

export interface ScriptHostOptions {
  // The scene this host queries. Optional so unit tests that don't exercise
  // the scene API can keep constructing a bare `new ScriptHost()`. Wiring
  // is done by World on host construction.
  scene?: EntityScene;
  // Injected so tests can substitute a recording console.
  console?: Pick<Console, 'log' | 'error' | 'warn' | 'info' | 'debug'>;
  // Host-only sound playback hook routed by World.broadcastPlaySound. When
  // absent, SceneFacade.playSound no-ops with a sandbox warning.
  playSound?: (slug: string) => void;
  // Optional asset-slug lookup for scene.playSound validation and
  // scene.assets.get(slug). Defaults to no validation; wiring the lookup
  // adds an actionable sandbox warning when a script calls playSound with
  // an unknown or wrong-typed slug, and lets `scene.assets.get` resolve
  // entries from the live catalog.
  lookupSlug?: (slug: string) => AssetEntry | undefined;
  // Optional manifest lister backing `scene.assets.list({ type })`.
  listAssets?: (opts?: { type?: AssetType }) => AssetEntry[];
  // Host-only sticker compositor backing `scene.attachSticker` (issue #9
  // of issues--ui-surface.md, refactored for issue #2 of issues--ui-surface-
  // refactor.md). Returns the new surface entity id + element id pair, or
  // null when the host can't honour the request. Absent on guest contexts.
  attachSticker?: (parentId: string, opts: StickerOpts) => { surfaceId: string; elementId: string } | null;
  // Host-only turn-tracker bridge backing `scene.turns`. Constructed by World
  // / Room wiring around the host's RoomStateManager.
  turns?: TurnsBridge;
  // Host-only bag operations backing `EntityFacade.bag`. World wires these
  // against BagService. Issue #4 of issues--bag.md.
  bagOps?: BagOps;
}

export type RunResult =
  | { ok: true }
  | { ok: false; error: string };

// Result of a one-time console run (`runOneShot`). Captured console.log /
// .error / .warn / .info / .debug lines are returned regardless of
// success so the panel can render partial output before a thrown error.
// `returnValue` carries whatever the user's `return X` resolved with
// (pre-formatted as a string) so the panel renders it without re-walking
// the value through a formatter.
export type OneShotResult =
  | { ok: true;  logs: LogLine[]; returnValue: string | null }
  | { ok: false; logs: LogLine[]; error: string };

// Persisted per-room script state. `source` is the authored TS the host
// last saved; `initialised` flips to true after `onSceneInitialised` fires
// for the first time on this room.
export interface ScriptState {
  source:      string;
  initialised: boolean;
}

export class ScriptHost {
  private readonly console_:        ScriptHostOptions['console'];
  private readonly scene_:          EntityScene | null;
  private readonly playSound_:      ScriptHostOptions['playSound'];
  private readonly lookupSlug_:     ScriptHostOptions['lookupSlug'];
  private readonly listAssets_:     ScriptHostOptions['listAssets'];
  private readonly attachSticker_:  ScriptHostOptions['attachSticker'];
  private readonly bagOps_:         ScriptHostOptions['bagOps'];
  private turns_:                   ScriptHostOptions['turns'];
  // Bounded ring buffer of script errors surfaced to the script panel
  // (issue #7). Hook errors, listener errors, AND startup-failure errors
  // (compile, module-load, structural, constructor) all funnel here so the
  // panel has a single unified stream. Source labels differentiate kind.
  private readonly errorLog_ = new ScriptErrorLog();
  private state_: ScriptState = { source: '', initialised: false };
  // Most recent successfully-instantiated user class. Held so a failed
  // re-Run (compile error) leaves it live — listeners attached against it
  // keep working until a successful Run replaces it.
  private currentInstance: Game | null = null;
  // Per-Run listener registrations. Each EntityFacade.addEventListener
  // appends; teardown iterates and removes from the underlying buses.
  // Replaced wholesale at the start of each successful Run so the previous
  // Run's listeners are dropped before the new class instantiates.
  private currentRunCtx: ScriptRunContext = { registrations: [] };

  constructor(opts: ScriptHostOptions = {}) {
    this.console_       = opts.console ?? console;
    this.scene_         = opts.scene   ?? null;
    this.playSound_     = opts.playSound;
    this.lookupSlug_    = opts.lookupSlug;
    this.listAssets_    = opts.listAssets;
    this.attachSticker_ = opts.attachSticker;
    this.bagOps_        = opts.bagOps;
    this.turns_         = opts.turns;
  }

  // Host wiring: install the turn-tracker bridge after construction. World
  // constructs ScriptHost before RoomStateManager exists, so Room.tsx wires
  // this in once the manager is available. Subsequent Runs see the bridge.
  setTurnsBridge(bridge: TurnsBridge | undefined): void {
    this.turns_ = bridge;
  }

  // Host wiring: dispatch a turn event to the current Game instance. The
  // RoomStateManager.onTurnEvent subscription routes through here so the
  // bridge owns the manager → script-host coupling, not the reverse.
  dispatchTurnEvent(event: TurnEvent): void {
    const instance = this.currentInstance;
    if (!instance) return;
    if (event.kind === 'turn-start') {
      this.invokeTurnHook(instance, 'onTurnStart', [event.seat, event.turnNumber]);
    } else {
      this.invokeTurnHook(instance, 'onTurnEnd', [event.seat, event.turnNumber, event.endedBy]);
    }
  }

  // Host wiring: route an end-turn request through the active Game instance
  // so scripts can gate or veto the advance.
  //
  // When the user's class doesn't override `onTurnEndRequested`, the engine
  // bypasses the hook and dispatches `next` directly with the originating
  // `endedBy` — preserving the 'player' / 'host' source per the PRD event
  // table. When the user *has* overridden the hook, control transfers to
  // them; any `scene.turns.next()` they call lands as `endedBy: 'script'`
  // because the decision was script-driven.
  dispatchEndTurnRequest(seat: SeatIndex, endedBy: 'player' | 'host'): void {
    const instance = this.currentInstance;
    if (!instance || isDefaultHook(instance, 'onTurnEndRequested')) {
      this.turns_?.dispatch({ kind: 'next', endedBy });
      return;
    }
    this.invokeTurnHook(instance, 'onTurnEndRequested', [seat]);
  }

  // Bounded ring of runtime errors (hook + listener). Subscribe via
  // `errorLog.subscribe(fn)` to re-render the script panel.
  get errorLog(): ScriptErrorLog {
    return this.errorLog_;
  }

  // Authoritative state slot for save/load. Returns a defensive copy so
  // callers can't mutate the live record.
  getScriptState(): ScriptState {
    return { source: this.state_.source, initialised: this.state_.initialised };
  }

  // Replaces the entire state slot. Used by tests and the save-file-load
  // path before `loadScript` runs the new source. Does not invoke hooks.
  loadScriptState(state: ScriptState): void {
    this.state_ = { source: state.source, initialised: state.initialised };
  }

  // Save Script — writes the textarea source into room state. `initialised`
  // is preserved.
  setSource(source: string): void {
    this.state_ = { source, initialised: this.state_.initialised };
  }

  // Save-file-load entrypoint. Replaces the state slot then runs the same
  // flow as `runScript` so the loaded `initialised` flag governs whether
  // `onSceneInitialised` fires.
  async loadScript(state: ScriptState): Promise<RunResult> {
    this.loadScriptState(state);
    if (!state.source) return { ok: true };
    return this.runScript(state.source);
  }

  async runScript(source: string): Promise<RunResult> {
    const compiled = await compileTypescript(source);
    if (!compiled.ok) {
      // Compile failure: leave the previously-running instance + listeners
      // alive. Surface the diagnostic in the log AND in the result so the
      // panel can render the error inline as a log entry.
      this.errorLog_.push('compile', new Error(compiled.error));
      return { ok: false, error: compiled.error };
    }

    // Fresh ScriptRunContext + SceneFacade per Run so EntityFacade caches
    // and listener registrations don't survive across Runs. The new context
    // is installed AFTER teardown of the previous Run so failed Runs don't
    // double-register against the same set.
    const ctx: ScriptRunContext = {
      registrations: [],
      errorLog:      this.errorLog_,
      console:       this.console_,
      playSound:     this.playSound_,
    };
    const scene = this.scene_
      ? new SceneFacade(this.scene_, ctx, {
          lookupSlug:    this.lookupSlug_,
          listAssets:    this.listAssets_,
          attachSticker: this.attachSticker_,
          turns:         this.turns_,
          bagOps:        this.bagOps_,
        })
      : {};

    let ns;
    try {
      ns = loadModule(compiled.js, {
        Game,
        scene,
        console: this.console_,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.console_?.error('[script] module load failed:', e);
      this.errorLog_.push('compile', e);
      return { ok: false, error: msg };
    }

    const Cls = ns.default;
    if (typeof Cls !== 'function') {
      const msg = 'Script must `export default` a class extending Game.';
      this.console_?.error('[script]', msg);
      this.errorLog_.push('compile', new Error(msg));
      return { ok: false, error: msg };
    }

    // Tear down the previous Run's listener registrations before any new
    // ones can be added. After this, the previous Run is fully retired.
    this.teardownPreviousRun();
    this.currentRunCtx = ctx;

    let instance: Game;
    try {
      instance = new (Cls as new () => Game)();
    } catch (e) {
      this.console_?.error('[script] constructor threw:', e);
      this.errorLog_.push('constructor', e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // Install the new instance before firing hooks so an exception during
    // a hook still leaves the new instance current (its listeners are
    // tracked in the Run context and torn down on the next Run regardless).
    this.currentInstance = instance;

    // Make `scene` reachable as `this.scene` from any hook so the base
    // `Game.onTurnEndRequested` default ("this.scene.turns.next()") works
    // without forcing every script author to save it in onSceneInitialised.
    (instance as unknown as { scene: unknown }).scene = scene;

    // Run does NOT persist `source` — Save Script (`setSource`) is the
    // explicit save path. The user might click Run on a draft they don't
    // want saved yet.
    if (!this.state_.initialised) {
      this.invokeHook(instance, 'onSceneInitialised', scene);
      this.state_ = { source: this.state_.source, initialised: true };
    }
    this.invokeHook(instance, 'onScriptLoaded', scene);

    return { ok: true };
  }

  // Host's one-time Console panel. Compiles + evaluates `source` once in a
  // fresh Compartment with `scene`, `game` (the current Game instance, may
  // be null), and a capturing `console`. Does NOT swap `currentRunCtx`, so
  // the main script's listener registrations survive — and any listeners
  // a one-shot adds are NOT tracked for teardown (documented in the panel
  // seed). The user wraps their code in an async IIFE; an explicit
  // `return X` surfaces as the panel's "result" line.
  async runOneShot(source: string): Promise<OneShotResult> {
    const compiled = await compileTypescript(wrapOneShotSource(source));
    if (!compiled.ok) {
      return { ok: false, logs: [], error: compiled.error };
    }

    const cap = makeCapturingConsole(this.console_);
    // Fresh registration set — never observed by teardown, so listeners
    // added during the one-shot leak by design. Documented at call site.
    const ctx: ScriptRunContext = {
      registrations: [],
      errorLog:      this.errorLog_,
      console:       cap.console,
      playSound:     this.playSound_,
    };
    const scene = this.scene_
      ? new SceneFacade(this.scene_, ctx, {
          lookupSlug:    this.lookupSlug_,
          listAssets:    this.listAssets_,
          attachSticker: this.attachSticker_,
          turns:         this.turns_,
          bagOps:        this.bagOps_,
        })
      : {};

    try {
      // Wrapper assigns `module.exports = (async () => { ... })();` so
      // `loadModule` returns the promise itself, not a namespace object.
      const exported = loadModule(compiled.js, {
        Game,
        scene,
        game:    this.currentInstance,
        console: cap.console,
      }) as unknown as Promise<unknown>;
      const value = await exported;
      return {
        ok:          true,
        logs:        cap.logs,
        returnValue: value === undefined ? null : formatArg(value),
      };
    } catch (e) {
      return {
        ok:    false,
        logs:  cap.logs,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Variant of invokeHook for turn hooks: the signature is (seat, ...rest)
  // rather than (scene). Wrapped in try/catch like the others so a buggy
  // script doesn't abort the engine's event-dispatch loop.
  // Note: function declarations below the class body are also in module scope.
  private invokeTurnHook(
    instance: Game,
    name: 'onTurnStart' | 'onTurnEnd' | 'onTurnEndRequested',
    args: unknown[],
  ): void {
    const fn = (instance as unknown as Record<string, unknown>)[name];
    if (typeof fn !== 'function') return;
    try {
      (fn as (...a: unknown[]) => void).apply(instance, args);
    } catch (e) {
      this.console_?.error(`[script] ${name} threw:`, e);
      this.errorLog_.push(name, e);
    }
  }

  // Iterates the per-Run registration set and detaches each listener from
  // its underlying entity bus. Runs before the next Run's class instantiates
  // so the new class never observes the previous Run's listeners.
  private teardownPreviousRun(): void {
    for (const r of this.currentRunCtx.registrations) r.dispose();
    this.currentRunCtx.registrations.length = 0;
  }

  private invokeHook(instance: Game, name: 'onSceneInitialised' | 'onScriptLoaded', scene: unknown): void {
    const fn = (instance as unknown as Record<string, unknown>)[name];
    if (typeof fn !== 'function') return;
    try {
      (fn as (s: unknown) => void).call(instance, scene);
    } catch (e) {
      this.console_?.error(`[script] ${name} threw:`, e);
      this.errorLog_.push(name, e);
    }
  }
}

// Returns true when `instance[name]` resolves to the same function the Game
// base class declares — i.e. the user did NOT override the hook. Walks the
// prototype chain via `===` rather than instanceof so a subclass that ALSO
// inherits straight from Game (without overriding) still hits the base.
function isDefaultHook(instance: Game, name: 'onTurnEndRequested'): boolean {
  const own = (instance as unknown as Record<string, unknown>)[name];
  const base = (Game.prototype as unknown as Record<string, unknown>)[name];
  return own === base;
}
