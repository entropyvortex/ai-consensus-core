import { EventEmitter } from "node:events";
import type { ConsensusEventMap } from "./types.js";

type AnyListener = (...args: unknown[]) => void;

/**
 * Thin, strictly-typed wrapper around Node's EventEmitter.
 *
 * We don't rely on Node 22+'s generic `EventEmitter<T>` so this works on every
 * Node 20+ release. The shape is intentionally narrow — if you need `prependListener`
 * or `rawListeners` for this, add them here and keep the types honest.
 *
 * The constraint is a self-referential mapped type rather than a bare
 * `Record<string, (...args: never[]) => void>` so that interface-based event
 * maps (which lack an implicit string index signature) satisfy it.
 */
export class TypedEventEmitter<
  Events extends { [K in keyof Events]: (...args: never[]) => void },
> {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Consensus runs can fan out to many observers (UI, logs, MCP progress…).
    // Default cap of 10 is too low for real-world use.
    this.emitter.setMaxListeners(0);
  }

  on<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    this.emitter.on(event, listener as unknown as AnyListener);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    this.emitter.once(event, listener as unknown as AnyListener);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    this.emitter.off(event, listener as unknown as AnyListener);
    return this;
  }

  removeAllListeners<K extends keyof Events & string>(event?: K): this {
    if (event) this.emitter.removeAllListeners(event);
    else this.emitter.removeAllListeners();
    return this;
  }

  listenerCount<K extends keyof Events & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  protected emit<K extends keyof Events & string>(
    event: K,
    ...args: Parameters<Events[K]>
  ): boolean {
    return this.emitter.emit(event, ...(args as unknown[]));
  }
}

/**
 * A narrower alias for consumers who want the concrete engine event map.
 */
export type ConsensusEmitter = TypedEventEmitter<ConsensusEventMap>;
