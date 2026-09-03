import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getConfigDir, getManifestsDir, loadAllManifests, loadConfig } from "./config.js";
import { detectHarnesses } from "./harnesses.js";

export interface HealthCheckResult {
  category: string;
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
}

/**
 * Checks system readiness, harness availability, and downstream server health.
 */
export function runDoctor(): HealthCheckResult[] {
  const results: HealthCheckResult[] = [];

  // 1. Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.replace(/^v/, "").split(".")[0], 10);
  if (majorVersion >= 20) {
    results.push({
      category: "Environment",
      name: "Node.js Runtime",
      status: "ok",
      message: `${nodeVersion} (Node >= 20 supported)`,
    });
  } else {
    results.push({
      category: "Environment",
      name: "Node.js Runtime",
      status: "error",
      message: `${nodeVersion} is outdated. Node.js >= 20 is required.`,
    });
  }

  // 2. Check Sloth configuration & cache paths
  const configDir = getConfigDir();
  const manifestsDir = getManifestsDir();
  results.push({
    category: "Storage",
    name: "Config Directory",
    status: existsSync(configDir) ? "ok" : "warn",
    message: configDir,
  });

  results.push({
    category: "Storage",
    name: "Manifests Cache Directory",
    status: existsSync(manifestsDir) ? "ok" : "warn",
    message: manifestsDir,
  });

  // 3. Check Detected AI Client Harnesses
  const harnesses = detectHarnesses();
  const installedCount = harnesses.filter((h) => h.installed).length;
  const activeSlothCount = harnesses.filter((h) => h.hasSlothConfigured).length;

  results.push({
    category: "Harnesses",
    name: "Installed AI Clients",
    status: installedCount > 0 ? "ok" : "warn",
    message: `${installedCount} client(s) detected, ${activeSlothCount} integrated with Sloth`,
  });

  // 4. Check Registered Downstream Servers
  const config = loadConfig();
  const manifests = loadAllManifests();
  const serverEntries = Object.entries(config.servers);

  if (serverEntries.length === 0) {
    results.push({
      category: "Servers",
      name: "Registered Downstream Servers",
      status: "warn",
      message: "No downstream servers configured yet. Run `sloth add <name> <command>` or `sloth import`.",
    });
  } else {
    for (const [name, srv] of serverEntries) {
      const manifest = manifests.get(name);
      const toolCount = manifest ? manifest.tools.length : 0;
      const statusLabel = srv.disabled ? "disabled" : "enabled";

      // Check if command is executable via `which`
      let commandExists = true;
      try {
        execSync(`which ${srv.command}`, { stdio: "ignore" });
      } catch {
        commandExists = false;
      }

      if (!commandExists) {
        results.push({
          category: "Servers",
          name: `Server '${name}'`,
          status: "warn",
          message: `Command '${srv.command}' not found in PATH (${statusLabel}, ${toolCount} cached tools)`,
        });
      } else {
        results.push({
          category: "Servers",
          name: `Server '${name}'`,
          status: "ok",
          message: `${srv.command} (${statusLabel}, ${toolCount} cached tools)`,
        });
      }
    }
  }

  return results;
}
