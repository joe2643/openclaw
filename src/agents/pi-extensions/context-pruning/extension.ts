import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildCachedMediaMarker,
  cacheMediaToDisk,
  mediaCacheKind,
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
 * Failures are handled gracefully: if a write fails, the original `[image removed]` marker
 * stays in place for that media block.
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

  // Replace markers in each affected message
  for (const [msgIndex, refs] of byIndex) {
    const msg = messages[msgIndex];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    const content = msg.content as (TextContent | { type: string })[];
    // Consume refs sequentially across blocks. Hard-clear emits one block per image,
    // so the outer loop must advance refIdx rather than restarting from 0 per block.
    let refIdx = 0;
    for (const block of content) {
      if (!("text" in block) || typeof block.text !== "string") {
        continue;
      }
      // Replace each PRUNED_CONTEXT_IMAGE_MARKER in this block with the next ref in order.
      while (block.text.includes(PRUNED_CONTEXT_IMAGE_MARKER) && refIdx < refs.length) {
        const ref = refs[refIdx++];
        const cachedPath = cachedPaths.get(ref);
        if (!cachedPath) {
          // Write failed; leave this marker in place and stop processing this block
          // to avoid infinite-looping on the unmodified marker.
          break;
        }
        const kind = mediaCacheKind(ref.mimeType);
        const cacheMarker = buildCachedMediaMarker(cachedPath, ref.mimeType, kind);
        block.text = block.text.replace(PRUNED_CONTEXT_IMAGE_MARKER, cacheMarker);
      }
    }
  }
}

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
    });

    if (next === event.messages) {
      return undefined;
    }

    // Optionally cache pruned media to disk
    if (runtime.settings.cacheMedia && prunedMedia.length > 0) {
      await writePrunedMediaCaches(next, prunedMedia);
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}
