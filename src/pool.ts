import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ServerConfig } from "./config.js";

/**
 * Ring buffer to retain the last N lines of downstream stderr
 */
export class StderrRingBuffer {
  private lines: string[] = [];
  private capacity: number;

  constructor(capacity = 50) {
    this.capacity = capacity;
  }

  public push(line: string): void {
    const trimmed = line.trimEnd();
    if (!trimmed) return;
    this.lines.push(trimmed);
    if (this.lines.length > this.capacity) {
      this.lines.shift();
    }
  }

  public getLines(): string[] {
    return [...this.lines];
  }

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
  onServerReaped?: (serverName: string) => void;
  onServerError?: (serverName: string, error: Error) => void;
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
  private onServerReaped?: (serverName: string) => void;
  private onServerError?: (serverName: string, error: Error) => void;
  private isShuttingDown = false;

  constructor(options: ProcessPoolOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.onServerReaped = options.onServerReaped;
    this.onServerError = options.onServerError;

    // Register process exit listeners
    this.registerExitHooks();
  }

  /**
   * Updates registered server configurations without restarting active processes.
   */
  public updateServerConfigs(configs: Record<string, ServerConfig>, idleTimeoutMs?: number): void {
    this.serverConfigs = { ...configs };
    if (idleTimeoutMs !== undefined) {
      this.idleTimeoutMs = idleTimeoutMs;
    }
  }

  /**
   * Acquires a connected Client instance for a server.
   * Spawns lazily on-demand if dormant; shares startup promise if already starting.
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
   */
  public release(serverName: string): void {
    const entry = this.activePool.get(serverName);
    if (!entry) return;

    entry.inFlightCount = Math.max(0, entry.inFlightCount - 1);
    entry.lastActivity = Date.now();

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
    const stderrBuffer = new StderrRingBuffer(50);

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
