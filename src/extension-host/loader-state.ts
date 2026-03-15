import type {
  PluginRecord,
  PluginRecordLifecycleState,
  PluginRegistry,
} from "../plugins/registry.js";

const EXTENSION_HOST_LIFECYCLE_STATUS_MAP: Record<
  PluginRecordLifecycleState,
  PluginRecord["status"]
> = {
  prepared: "loaded",
  disabled: "disabled",
  validated: "loaded",
  registered: "loaded",
  error: "error",
};

export function setExtensionHostPluginRecordLifecycleState(
  record: PluginRecord,
  nextState: PluginRecordLifecycleState,
  opts?: { error?: string },
): PluginRecord {
  record.lifecycleState = nextState;
  record.status = EXTENSION_HOST_LIFECYCLE_STATUS_MAP[nextState];

  if (nextState === "disabled") {
    record.enabled = false;
    record.error = opts?.error;
    return record;
  }
  if (nextState === "error") {
    record.error = opts?.error;
    return record;
  }
  if (opts?.error === undefined) {
    delete record.error;
  }
  return record;
}

export function setExtensionHostPluginRecordDisabled(
  record: PluginRecord,
  reason?: string,
): PluginRecord {
  return setExtensionHostPluginRecordLifecycleState(record, "disabled", { error: reason });
}

export function setExtensionHostPluginRecordError(
  record: PluginRecord,
  message: string,
): PluginRecord {
  return setExtensionHostPluginRecordLifecycleState(record, "error", { error: message });
}

export function appendExtensionHostPluginRecord(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds?: Map<string, PluginRecord["origin"]>;
  pluginId?: string;
  origin?: PluginRecord["origin"];
}): void {
  params.registry.plugins.push(params.record);
  if (params.seenIds && params.pluginId && params.origin) {
    params.seenIds.set(params.pluginId, params.origin);
  }
}
