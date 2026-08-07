import type {
  RacpClient,
  RacpMessageHandler,
  RacpPersistedMessage,
  RacpQueryInput,
  RacpSendInput,
} from "@rnby/racp-client";

export type RacpBridgeState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "faulted";

export type RacpBridgeErrorCode =
  | "driver_required"
  | "already_running"
  | "driver_failed"
  | "stop_failed";

export class RacpBridgeError extends Error {
  readonly code: RacpBridgeErrorCode;
  declare readonly cause?: unknown;

  constructor(code: RacpBridgeErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RacpBridgeError";
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }
}

export interface RacpBridgeContext {
  readonly client: RacpClient;
  readonly signal: AbortSignal;
  send(input: RacpSendInput): Promise<RacpPersistedMessage>;
  query(input: RacpQueryInput): Promise<RacpPersistedMessage>;
  onMessage(handler: RacpMessageHandler): () => void;
}

export interface RacpBridgeHandle {
  readonly address?: string;
  close(): Promise<void>;
}

/**
 * A daemon driver owns sockets/process integration. The bridge package owns
 * only this typed lifecycle boundary and never starts a network listener by
 * itself.
 */
export interface RacpBridgeDriver {
  start(context: RacpBridgeContext): Promise<RacpBridgeHandle>;
}

export interface RacpBridgeOptions {
  client: RacpClient;
  driver?: RacpBridgeDriver;
}

export interface RacpBridgeSnapshot {
  state: RacpBridgeState;
  address: string | null;
  lastError: string | null;
}

export class RacpBridge {
  private readonly client: RacpClient;
  private readonly driver: RacpBridgeDriver | undefined;
  private readonly stateHandlers = new Set<(state: RacpBridgeState) => void>();
  private currentState: RacpBridgeState = "stopped";
  private controller: AbortController | null = null;
  private handle: RacpBridgeHandle | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(options: RacpBridgeOptions) {
    this.client = options.client;
    this.driver = options.driver;
  }

  get state(): RacpBridgeState {
    return this.currentState;
  }

  snapshot(): RacpBridgeSnapshot {
    return {
      state: this.currentState,
      address: this.handle?.address ?? null,
      lastError: this.lastError,
    };
  }

  onStateChange(handler: (state: RacpBridgeState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.currentState !== "stopped" && this.currentState !== "faulted") {
      throw new RacpBridgeError(
        "already_running",
        "RACP bridge is already running or changing state.",
      );
    }
    if (!this.driver) {
      this.lastError =
        "No bridge driver is configured. Supply an explicit local daemon adapter.";
      this.setState("faulted");
      throw new RacpBridgeError("driver_required", this.lastError);
    }

    const controller = new AbortController();
    this.controller = controller;
    this.setState("starting");
    const startPromise = this.startDriver(controller);
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.currentState === "stopped") return;
    if (this.stopPromise) return this.stopPromise;

    const stopPromise = this.stopBridge();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = null;
      }
    }
  }

  private async startDriver(controller: AbortController): Promise<void> {
    if (!this.isActiveStart(controller)) return;
    try {
      await this.client.start();
      if (!this.isActiveStart(controller)) return;

      const context: RacpBridgeContext = {
        client: this.client,
        signal: controller.signal,
        send: (input) => this.client.send(input),
        query: (input) => this.client.query(input),
        onMessage: (handler) => this.client.onMessage(handler),
      };
      const handle = await this.driver!.start(context);
      if (!this.isActiveStart(controller)) {
        try {
          await handle.close();
        } catch (cause) {
          throw new RacpBridgeError(
            "stop_failed",
            "RACP bridge driver returned during shutdown and its handle failed to close.",
            cause,
          );
        }
        return;
      }

      this.handle = handle;
      this.lastError = null;
      this.setState("running");
    } catch (cause) {
      const cancelled = !this.isActiveStart(controller);
      if (cancelled) {
        if (cause instanceof RacpBridgeError && cause.code === "stop_failed") {
          throw cause;
        }
        return;
      }

      controller.abort();
      if (this.controller === controller) {
        this.controller = null;
      }
      this.handle = null;

      let failureCause: unknown = cause;
      try {
        await this.client.stop();
      } catch (stopCause) {
        failureCause = new AggregateError(
          [cause, stopCause],
          "RACP bridge startup and client cleanup both failed.",
        );
      }
      this.lastError = "RACP bridge driver failed to start.";
      this.setState("faulted");
      if (cause instanceof RacpBridgeError) throw cause;
      throw new RacpBridgeError("driver_failed", this.lastError, failureCause);
    }
  }

  private async stopBridge(): Promise<void> {
    this.setState("stopping");
    this.controller?.abort();
    this.controller = null;

    const failures: Array<{ phase: "startup" | "driver" | "client"; cause: unknown }> = [];
    const startPromise = this.startPromise;
    if (startPromise) {
      try {
        await startPromise;
      } catch (cause) {
        failures.push({ phase: "startup", cause });
      }
    }

    const handle = this.handle;
    this.handle = null;
    if (handle) {
      try {
        await handle.close();
      } catch (cause) {
        failures.push({ phase: "driver", cause });
      }
    }

    try {
      await this.client.stop();
    } catch (cause) {
      failures.push({ phase: "client", cause });
    }

    if (failures.length === 0) {
      this.lastError = null;
      this.setState("stopped");
      return;
    }

    const phases = new Set(failures.map((failure) => failure.phase));
    const message =
      phases.size > 1
        ? "RACP bridge shutdown failed in multiple cleanup phases."
        : phases.has("driver")
          ? "RACP bridge driver handle failed to close."
          : phases.has("client")
            ? "RACP client failed to stop."
            : "RACP bridge startup cleanup failed during shutdown.";
    const cause =
      failures.length === 1
        ? failures[0]!.cause
        : new AggregateError(
            failures.map((failure) => failure.cause),
            message,
          );
    this.lastError = message;
    this.setState("stopped");
    throw new RacpBridgeError("stop_failed", message, cause);
  }

  private isActiveStart(controller: AbortController): boolean {
    return (
      this.controller === controller &&
      !controller.signal.aborted &&
      this.currentState === "starting"
    );
  }

  private setState(state: RacpBridgeState) {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch {
        // Observers never control daemon lifecycle.
      }
    }
  }
}

/** Create the intentionally inert default; start() fails until a driver exists. */
export function createRacpBridgeStub(client: RacpClient): RacpBridge {
  return new RacpBridge({ client });
}

export function createRacpBridge(
  client: RacpClient,
  driver: RacpBridgeDriver,
): RacpBridge {
  return new RacpBridge({ client, driver });
}
