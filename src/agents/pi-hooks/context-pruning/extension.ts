import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildCachedMediaMarker,
  cacheMediaToDisk,
  mediaCacheKind,
  pruneMediaCache,
} from "../../../media/media-cache.js";
import {
  PRUNED_CONTEXT_IMAGE_MARKER,
  type PrunedMediaRef,
  pruneContextMessagesWithMediaCollection,
} from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

/**
 * Write pruned media blocks to the cache directory and replace their placeholder markers
 * in the pruned messages with `[media cached: ...]` markers.
 *
 * Failures are handled gracefully: if a write fails, the original
 * `[image removed during context pruning]` marker stays in place for that media block.
 *
 * Note: mutates text content blocks in `messages` in-place. This is safe because the
 * messages array is the pruner's output (a fresh shallow copy with newly-created content
 * objects), not the original session message array.
 */
async function writePrunedMediaCaches(
  messages: AgentMessage[],
  prunedMedia: PrunedMediaRef[],
): Promise<void> {
  // Group by message index to handle sequential marker replacement
  const byIndex = new Map<number, PrunedMediaRef[]>();
  for (const ref of prunedMedia) {
    const group = byIndex.get(ref.messageIndex);
    if (group) {
      group.push(ref);
    } else {
      byIndex.set(ref.messageIndex, [ref]);
    }
  }

  // Write all media to disk concurrently
  const results = await Promise.allSettled(
    prunedMedia.map((ref) => cacheMediaToDisk(ref.data, ref.mimeType)),
  );

  // Build a mapping from PrunedMediaRef → cached path (or null on failure)
  const cachedPaths = new Map<PrunedMediaRef, string | null>();
  for (let i = 0; i < prunedMedia.length; i++) {
    const result = results[i];
    cachedPaths.set(prunedMedia[i], result?.status === "fulfilled" ? result.value.path : null);
  }

  // Replace markers in each affected message. refIdx advances across all blocks so
  // each marker slot (whether in a single joined soft-trim block or one-per-block
  // hard-clear) maps to the correct PrunedMediaRef in order.
  for (const [msgIndex, refs] of byIndex) {
    const msg = messages[msgIndex];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    const content = msg.content as (TextContent | { type: string })[];
    let refIdx = 0;
    for (const block of content) {
      if (!("text" in block) || typeof block.text !== "string") {
        continue;
      }
      // Split on the marker so each slot is processed independently.
      // This handles both single-marker blocks (hard-clear) and multi-marker blocks
      // (soft-trim joining multiple images into one text block). A failed write for
      // one slot leaves that marker in place without skipping subsequent slots.
      const segments = block.text.split(PRUNED_CONTEXT_IMAGE_MARKER);
      if (segments.length <= 1) {
        continue;
      }
      const rebuilt: string[] = [segments[0] ?? ""];
      for (let s = 1; s < segments.length; s++) {
        if (refIdx < refs.length) {
          const ref = refs[refIdx++];
          const cachedPath = cachedPaths.get(ref);
          if (cachedPath) {
            const kind = mediaCacheKind(ref.mimeType);
            rebuilt.push(buildCachedMediaMarker(cachedPath, ref.mimeType, kind));
          } else {
            rebuilt.push(PRUNED_CONTEXT_IMAGE_MARKER); // write failed; keep original
          }
        } else {
          rebuilt.push(PRUNED_CONTEXT_IMAGE_MARKER); // no ref for this slot
        }
        rebuilt.push(segments[s] ?? "");
      }
      block.text = rebuilt.join("");
    }
  }
}

const CACHE_PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // at most once per day
let lastCachePruneAt = 0;

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }

    const { messages: next, prunedMedia } = pruneContextMessagesWithMediaCollection({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
      dropThinkingBlocksForEstimate: runtime.dropThinkingBlocks,
    });

    if (next === event.messages) {
      return undefined;
    }

    // Optionally cache pruned media to disk
    if (runtime.settings.cacheMedia && prunedMedia.length > 0) {
      await writePrunedMediaCaches(next, prunedMedia);
      // Periodically prune old cache files to prevent unbounded disk growth.
      const now = Date.now();
      if (now - lastCachePruneAt > CACHE_PRUNE_INTERVAL_MS) {
        lastCachePruneAt = now;
        pruneMediaCache(CACHE_PRUNE_MAX_AGE_MS).catch(() => {});
      }
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}
