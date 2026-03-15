import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "../plugins/discovery.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  buildExtensionHostProvenanceIndex,
  compareExtensionHostDuplicateCandidateOrder,
  createExtensionHostPluginRecord,
  warnAboutUntrackedLoadedExtensions,
  warnWhenExtensionAllowlistIsOpen,
} from "./loader-policy.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-loader-policy-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension host loader policy", () => {
  it("creates normalized plugin records", () => {
    const record = createExtensionHostPluginRecord({
      id: "demo-plugin",
      source: "/plugins/demo/index.js",
      origin: "workspace",
      enabled: true,
      configSchema: true,
    });

    expect(record).toMatchObject({
      id: "demo-plugin",
      name: "demo-plugin",
      source: "/plugins/demo/index.js",
      origin: "workspace",
      enabled: true,
      status: "loaded",
      lifecycleState: "prepared",
      configSchema: true,
    });
  });

  it("prefers explicit global installs over auto-discovered globals", () => {
    const installDir = makeTempDir();
    const autoDir = makeTempDir();
    const env = { ...process.env, HOME: makeTempDir() };
    const provenance = buildExtensionHostProvenanceIndex({
      config: {
        plugins: {
          installs: {
            demo: {
              installPath: installDir,
            },
          },
        },
      },
      normalizedLoadPaths: [],
      env,
    });

    const manifestByRoot = new Map<string, { id: string }>([
      [installDir, { id: "demo" }],
      [autoDir, { id: "demo" }],
    ]);
    const explicitCandidate: PluginCandidate = {
      idHint: "demo",
      source: path.join(installDir, "index.js"),
      rootDir: installDir,
      origin: "global",
    };
    const autoCandidate: PluginCandidate = {
      idHint: "demo",
      source: path.join(autoDir, "index.js"),
      rootDir: autoDir,
      origin: "global",
    };

    expect(
      compareExtensionHostDuplicateCandidateOrder({
        left: explicitCandidate,
        right: autoCandidate,
        manifestByRoot,
        provenance,
        env,
      }),
    ).toBeLessThan(0);
  });

  it("warns when allowlist is open for non-bundled discoverable plugins", () => {
    const warnings: string[] = [];
    const warningCache = new Set<string>();

    warnWhenExtensionAllowlistIsOpen({
      logger: {
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
      pluginsEnabled: true,
      allow: [],
      warningCacheKey: "warn-key",
      warningCache,
      discoverablePlugins: [
        { id: "bundled", source: "/bundled/index.js", origin: "bundled" },
        { id: "workspace-demo", source: "/workspace/demo.js", origin: "workspace" },
      ],
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("plugins.allow is empty");
    expect(warningCache.has("warn-key")).toBe(true);
  });

  it("warns about loaded untracked non-bundled plugins", () => {
    const trackedDir = makeTempDir();
    const untrackedDir = makeTempDir();
    const trackedFile = path.join(trackedDir, "tracked.js");
    const untrackedFile = path.join(untrackedDir, "untracked.js");
    fs.writeFileSync(trackedFile, "export {};\n", "utf8");
    fs.writeFileSync(untrackedFile, "export {};\n", "utf8");

    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      {
        ...createExtensionHostPluginRecord({
          id: "tracked",
          source: trackedFile,
          origin: "workspace",
          enabled: true,
          configSchema: false,
        }),
        status: "loaded",
      },
      {
        ...createExtensionHostPluginRecord({
          id: "untracked",
          source: untrackedFile,
          origin: "workspace",
          enabled: true,
          configSchema: false,
        }),
        status: "loaded",
      },
    );

    const warnings: string[] = [];
    const env = { ...process.env, HOME: makeTempDir() };
    const provenance = buildExtensionHostProvenanceIndex({
      config: {},
      normalizedLoadPaths: [trackedDir],
      env,
    });

    warnAboutUntrackedLoadedExtensions({
      registry,
      provenance,
      logger: {
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
      env,
    });

    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.pluginId).toBe("untracked");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("untracked");
  });
});
