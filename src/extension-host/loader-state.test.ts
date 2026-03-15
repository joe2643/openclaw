import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import { createExtensionHostPluginRecord } from "./loader-policy.js";
import {
  appendExtensionHostPluginRecord,
  setExtensionHostPluginRecordLifecycleState,
  setExtensionHostPluginRecordDisabled,
  setExtensionHostPluginRecordError,
} from "./loader-state.js";

function createRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

describe("extension host loader state", () => {
  it("maps explicit lifecycle states onto compatibility status values", () => {
    const record = createExtensionHostPluginRecord({
      id: "demo",
      source: "/plugins/demo.js",
      origin: "workspace",
      enabled: true,
      configSchema: true,
    });

    expect(setExtensionHostPluginRecordLifecycleState(record, "validated")).toMatchObject({
      lifecycleState: "validated",
      status: "loaded",
    });
    expect(setExtensionHostPluginRecordLifecycleState(record, "registered")).toMatchObject({
      lifecycleState: "registered",
      status: "loaded",
    });
  });

  it("marks plugin records disabled", () => {
    const record = createExtensionHostPluginRecord({
      id: "demo",
      source: "/plugins/demo.js",
      origin: "workspace",
      enabled: true,
      configSchema: true,
    });

    expect(setExtensionHostPluginRecordDisabled(record, "disabled by policy")).toMatchObject({
      enabled: false,
      status: "disabled",
      lifecycleState: "disabled",
      error: "disabled by policy",
    });
  });

  it("marks plugin records as errors", () => {
    const record = createExtensionHostPluginRecord({
      id: "demo",
      source: "/plugins/demo.js",
      origin: "workspace",
      enabled: true,
      configSchema: true,
    });

    expect(setExtensionHostPluginRecordError(record, "failed to load")).toMatchObject({
      status: "error",
      lifecycleState: "error",
      error: "failed to load",
    });
  });

  it("appends records and optionally updates seen ids", () => {
    const registry = createRegistry();
    const seenIds = new Map<string, "workspace" | "global" | "bundled" | "config">();
    const record = createExtensionHostPluginRecord({
      id: "demo",
      source: "/plugins/demo.js",
      origin: "workspace",
      enabled: true,
      configSchema: true,
    });

    appendExtensionHostPluginRecord({
      registry,
      record,
      seenIds,
      pluginId: "demo",
      origin: "workspace",
    });

    expect(registry.plugins).toEqual([record]);
    expect(seenIds.get("demo")).toBe("workspace");
  });
});
