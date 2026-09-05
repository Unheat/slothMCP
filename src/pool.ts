import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { computeSchemaFingerprint, saveManifest, type ServerConfig, type ToolDefinition } from "./config.js";

/** Default circular buffer capacity for retaining child stderr lines */
export const DEFAULT_RING_BUFFER_CAPACITY = 50;

/** Default inactivity timeout before reaping idle on-demand child processes (5 minutes) */
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 300_000;

/** Default timeout to wait after SIGTERM before escalating to SIGKILL */
export const SIGKILL_ESCALATION_DELAY_MS = 3_000;

/**
 * Ring buffer to retain the last N lines of downstream stderr
 */
export class StderrRingBuffer {
  private lines: string[] = [];
  private capacity: number;

  /**
   * @param capacity - Maximum number of lines to retain in memory (default: 50)
   */
  constructor(capacity = DEFAULT_RING_BUFFER_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * Appends a line to the ring buffer, evicting the oldest line if capacity is exceeded.
   *
   * @param line - Raw text line from stderr
   */
  public push(line: string): void {
    const trimmed = line.trimEnd();
    if (!trimmed) return;
    this.lines.push(trimmed);
    if (this.lines.length > this.capacity) {
      this.lines.shift();
    }
  }

  /**
   * Retrieves all buffered stderr lines in chronological order.
   *
   * @returns Array of stderr lines
   */
  public getLines(): string[] {
    return [...this.lines];
  }

  /**
   * Clears all buffered lines.
   */
  public clear(): void {
    this.lines = [];
  }
}

export interface PoolEntry {
  serverName: string;
  client: Client;
  transport: StdioClientTransport;
  inFlightCount: number;
  idleTimer: NodeJS.Timeout | null;
  lastActivity: number;
  stderrBuffer: StderrRingBuffer;
}

export interface ProcessPoolOptions {
  idleTimeoutMs?: number; // default 300,000 (5 min)
  defaultOnDemand?: boolean; // default: true
  onServerReaped?: (serverName: string) => void;
  onServerError?: (serverName: string, error: Error) => void;
  onToolsChanged?: (serverName: string, tools: ToolDefinition[]) => void;
}

/**
 * Manages lazy downstream child processes over stdio with on-demand spawn,
 * single-flight startup locks, and automated TTL idle reaping.
 */
export class ProcessPool {
  private activePool = new Map<string, PoolEntry>();
  private startingLocks = new Map<string, Promise<PoolEntry>>();
  private serverConfigs: Record<string, ServerConfig> = {};
  private idleTimeoutMs: number;
  private defaultOnDemand: boolean;
  private onServerReaped?: (serverName: string) => void;
  private onServerError?: (serverName: string, error: Error) => void;
  private onToolsChanged?: (serverName: string, tools: ToolDefinition[]) => void;
  private isShuttingDown = false;

  /**
   * @param options - Pool configuration options
   */
  constructor(options: ProcessPoolOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_POOL_IDLE_TIMEOUT_MS;
    this.defaultOnDemand = options.defaultOnDemand ?? true;
    this.onServerReaped = options.onServerReaped;
    this.onServerError = options.onServerError;
    this.onToolsChanged = options.onToolsChanged;

    // Register process exit listeners
    this.registerExitHooks();
  }

  /**
   * Resolves whether a specific server is configured for on-demand lazy lifecycle.
   * If onDemand is undefined on the server, falls back to defaultOnDemand.
   *
   * @param serverName - Identifier name of the server
   * @returns True if on-demand, false if always-on persistent
   */
  public isOnDemand(serverName: string): boolean {
    const cfg = this.serverConfigs[serverName];
    if (!cfg) return this.defaultOnDemand;
    return cfg.onDemand !== undefined ? cfg.onDemand : this.defaultOnDemand;
  }

  /**
   * Updates registered server configurations without restarting active processes.
   *
   * @param configs - Updated map of server configurations
   * @param idleTimeoutMs - Optional updated idle timeout in milliseconds
   * @param defaultOnDemand - Optional updated default on-demand posture
   */
  public updateServerConfigs(
    configs: Record<string, ServerConfig>,
    idleTimeoutMs?: number,
    defaultOnDemand?: boolean
  ): void {
    this.serverConfigs = { ...configs };
    if (idleTimeoutMs !== undefined) {
      this.idleTimeoutMs = idleTimeoutMs;
    }
    if (defaultOnDemand !== undefined) {
      this.defaultOnDemand = defaultOnDemand;
    }
  }

  /**
   * Pre-warms / boots all enabled persistent servers (onDemand: false) on gateway startup.
   *
   * @returns Array of booted server names
   */
  public async bootPersistentServers(): Promise<string[]> {
    const booted: string[] = [];
    const promises: Promise<unknown>[] = [];

    for (const [name, cfg] of Object.entries(this.serverConfigs)) {
      if (!cfg.disabled && !this.isOnDemand(name)) {
        booted.push(name);
        promises.push(
          this.acquire(name).catch((err) => {
            console.error(`[SlothProcessPool] Failed to pre-boot persistent server '${name}':`, err);
          })
        );
      }
    }

    await Promise.allSettled(promises);
    return booted;
  }

  /**
   * Acquires a connected Client instance for a server.
   * Spawns lazily on-demand if dormant; shares startup promise if already starting.
   *
   * @param serverName - Identifier name of the target server
   * @returns Connected Client instance
   */
  public async acquire(serverName: string): Promise<Client> {
    if (this.isShuttingDown) {
      throw new Error(`ProcessPool is shutting down. Cannot acquire server '${serverName}'.`);
    }

    const config = this.serverConfigs[serverName];
    if (!config) {
      throw new Error(`Downstream server '${serverName}' is not registered in configuration.`);
    }

    if (config.disabled) {
      throw new Error(`Downstream server '${serverName}' is disabled.`);
    }

    // 1. If already active and ready
    const existing = this.activePool.get(serverName);
    if (existing) {
      // Clear idle timer since it is now active
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      existing.inFlightCount++;
      existing.lastActivity = Date.now();
      return existing.client;
    }

    // 2. If currently starting, join the single-flight promise
    const starting = this.startingLocks.get(serverName);
    if (starting) {
      const entry = await starting;
      entry.inFlightCount++;
      entry.lastActivity = Date.now();
      return entry.client;
    }

    // 3. Spawn dormant server
    const startPromise = this.spawnServer(serverName, config);
    this.startingLocks.set(serverName, startPromise);

    try {
      const entry = await startPromise;
      entry.inFlightCount++;
      entry.lastActivity = Date.now();
      return entry.client;
    } finally {
      this.startingLocks.delete(serverName);
    }
  }

  /**
   * Releases a client after tool call execution.
   * Starts or resets the idle timer when inFlightCount reaches 0.
   *
   * @param serverName - Identifier name of the server to release
   */
  public release(serverName: string): void {
    const entry = this.activePool.get(serverName);
    if (!entry) return;

    entry.inFlightCount = Math.max(0, entry.inFlightCount - 1);
    entry.lastActivity = Date.now();

    // If server is configured as always-on (onDemand: false), do not schedule idle reap
    if (!this.isOnDemand(serverName)) {
      return;
    }

    if (entry.inFlightCount === 0 && !this.isShuttingDown) {
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
      }

      entry.idleTimer = setTimeout(() => {
        void this.reapServer(serverName);
      }, this.idleTimeoutMs);
    }
  }

  /**
   * Executes a tool against a downstream server safely with acquire / release wrapping.
   *
   * @param serverName - Identifier name of the server
   * @param toolName - Target tool name to execute
   * @param args - Tool invocation arguments object
   * @returns Raw tool result payload from downstream server
   */
  public async executeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    const client = await this.acquire(serverName);
    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });
      return result;
    } finally {
      this.release(serverName);
    }
  }

  /**
   * Introspects tools on demand (used by sloth sync / sloth add).
   * Spawns, fetches tools/list, and immediately closes if temporary=true.
   *
   * @param serverName - Identifier name of the server
   * @param temporary - Whether to immediately shut down child process after introspecting
   * @returns Array of raw ToolDefinition objects
   */
  public async introspectTools(serverName: string, temporary = true): Promise<unknown[]> {
    const client = await this.acquire(serverName);
    try {
      const list = await client.listTools();
      return list.tools || [];
    } finally {
      this.release(serverName);
      if (temporary) {
        await this.stopServer(serverName);
      }
    }
  }

  /**
   * Spawns a child process and initializes MCP connection.
   */
  private async spawnServer(serverName: string, config: ServerConfig): Promise<PoolEntry> {
    const stderrBuffer = new StderrRingBuffer(DEFAULT_RING_BUFFER_CAPACITY);

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: {
        ...(process.env as Record<string, string>),
        ...(config.env || {}),
      },
      stderr: "pipe",
    });

    const client = new Client({
      name: `sloth-gateway-client-${serverName}`,
      version: "0.1.0",
    });

    // Capture stderr stream into ring buffer
    if (transport.stderr) {
      transport.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            stderrBuffer.push(line);
          }
        }
      });
    }

    try {
      await client.connect(transport);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[SlothProcessPool] Failed to connect to server '${serverName}':`, error.message);
      this.onServerError?.(serverName, error);
      throw error;
    }

    // Register real-time tools/list_changed notification handler
    try {
      (client as unknown as { setNotificationHandler: (method: string, cb: () => Promise<void>) => void }).setNotificationHandler(
        "notifications/tools/list_changed",
        async () => {
          console.error(`[SlothProcessPool] Received tools/list_changed notification from '${serverName}'`);
          try {
            const freshTools = (await client.listTools()).tools || [];
            const fingerprint = computeSchemaFingerprint(freshTools as ToolDefinition[]);
            saveManifest({
              server: serverName,
              fingerprint,
              indexedAt: Date.now(),
              tools: freshTools as ToolDefinition[],
            });
            this.onToolsChanged?.(serverName, freshTools as ToolDefinition[]);
          } catch (syncErr) {
            console.error(`[SlothProcessPool] Error syncing changed tools for '${serverName}':`, syncErr);
          }
        }
      );
    } catch {
      // Notification handler registration may be unsupported by legacy transports
    }

    const entry: PoolEntry = {
      serverName,
      client,
      transport,
      inFlightCount: 0,
      idleTimer: null,
      lastActivity: Date.now(),
      stderrBuffer,
    };

    this.activePool.set(serverName, entry);
    return entry;
  }

  /**
   * Reaps an idle server after the inactivity TTL expires.
   */
  private async reapServer(serverName: string): Promise<void> {
    const entry = this.activePool.get(serverName);
    if (!entry) return;

    if (entry.inFlightCount > 0) {
      // Busy, do not reap
      return;
    }

    console.error(`[SlothProcessPool] Reaping idle server '${serverName}' after ${this.idleTimeoutMs}ms`);
    await this.stopServer(serverName);
    this.onServerReaped?.(serverName);
  }

  /**
   * Gracefully terminates a running server child process.
   *
   * @param serverName - Identifier name of the server to stop
   */
  public async stopServer(serverName: string): Promise<void> {
    const entry = this.activePool.get(serverName);
    if (!entry) return;

    this.activePool.delete(serverName);

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    try {
      await entry.client.close();
    } catch {
      // Ignore client close errors
    }

    try {
      await entry.transport.close();
    } catch {
      // Ignore transport close errors
    }
  }

  /**
   * Stops all active downstream child processes.
   */
  public async stopAll(): Promise<void> {
    const servers = Array.from(this.activePool.keys());
    await Promise.allSettled(servers.map((s) => this.stopServer(s)));
  }

  /**
   * Returns whether a server process is currently running and active.
   *
   * @param serverName - Identifier name of the server
   * @returns True if server process is running
   */
  public isRunning(serverName: string): boolean {
    return this.activePool.has(serverName);
  }

  /**
   * Returns the count of currently running child processes.
   */
  public get activeCount(): number {
    return this.activePool.size;
  }

  /**
   * Returns recent stderr lines for a server (for debugging/diagnostics).
   *
   * @param serverName - Identifier name of the server
   * @returns Array of recent stderr output lines
   */
  public getStderr(serverName: string): string[] {
    const entry = this.activePool.get(serverName);
    return entry ? entry.stderrBuffer.getLines() : [];
  }

  private registerExitHooks(): void {
    const cleanup = () => {
      void this.stopAll();
    };

    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
}
