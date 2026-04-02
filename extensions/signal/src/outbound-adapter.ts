import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  attachChannelToResults,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { createScopedChannelMediaMaxBytesResolver } from "openclaw/plugin-sdk/media-runtime";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/outbound-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { stripAssistantInternalScaffolding } from "openclaw/plugin-sdk/text-runtime";
import { markdownToSignalTextChunks } from "./format.js";
import { sendMessageSignal } from "./send.js";

/**
 * Strip reasoning tags and other assistant-internal scaffolding from text
 * before delivering to Signal. Tag-based reasoning models (Qwen, GLM,
 * DeepSeek) embed <think> blocks in the text stream which must not reach
 * the end user.
 */
function sanitizeOutboundText(text: string): string {
  if (!text) {
    return text;
  }
  let cleaned = stripAssistantInternalScaffolding(text);
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

function resolveSignalSender(deps: OutboundSendDeps | undefined) {
  return resolveOutboundSendDep<typeof sendMessageSignal>(deps, "signal") ?? sendMessageSignal;
}

const resolveSignalMaxBytes = createScopedChannelMediaMaxBytesResolver("signal");
type SignalSendOpts = NonNullable<Parameters<typeof sendMessageSignal>[2]>;

function inferSignalTableMode(params: { cfg: SignalSendOpts["cfg"]; accountId?: string | null }) {
  return resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId ?? undefined,
  });
}

export const signalOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, _limit) => text.split(/\n{2,}/).flatMap((chunk) => (chunk ? [chunk] : [])),
  chunkerMode: "text",
  textChunkLimit: 4000,
  sendFormattedText: async ({ cfg, to, text, accountId, deps, abortSignal }) => {
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes({
      cfg,
      accountId: accountId ?? undefined,
    });
    const limit = resolveTextChunkLimit(cfg, "signal", accountId ?? undefined, {
      fallbackLimit: 4000,
    });
    const tableMode = inferSignalTableMode({ cfg, accountId });
    const sanitized = sanitizeOutboundText(text);
    let chunks =
      limit === undefined
        ? markdownToSignalTextChunks(sanitized, Number.POSITIVE_INFINITY, { tableMode })
        : markdownToSignalTextChunks(sanitized, limit, { tableMode });
    if (chunks.length === 0 && text) {
      chunks = [{ text, styles: [] }];
    }
    const results = [];
    for (const chunk of chunks) {
      abortSignal?.throwIfAborted();
      const result = await send(to, chunk.text, {
        cfg,
        maxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: chunk.styles,
      });
      results.push(result);
    }
    return attachChannelToResults("signal", results);
  },
  sendFormattedMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes({
      cfg,
      accountId: accountId ?? undefined,
    });
    const tableMode = inferSignalTableMode({ cfg, accountId });
    const sanitized = sanitizeOutboundText(text);
    const formatted = markdownToSignalTextChunks(sanitized, Number.POSITIVE_INFINITY, {
      tableMode,
    })[0] ?? {
      text,
      styles: [],
    };
    const result = await send(to, formatted.text, {
      cfg,
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
      textMode: "plain",
      textStyles: formatted.styles,
      mediaLocalRoots,
      mediaReadFile,
    });
    return attachChannelToResult("signal", result);
  },
  ...createAttachedChannelResultAdapter({
    channel: "signal",
    sendText: async ({ cfg, to, text, accountId, deps }) => {
      const send = resolveSignalSender(deps);
      const maxBytes = resolveSignalMaxBytes({
        cfg,
        accountId: accountId ?? undefined,
      });
      return await send(to, sanitizeOutboundText(text), {
        cfg,
        maxBytes,
        accountId: accountId ?? undefined,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
    }) => {
      const send = resolveSignalSender(deps);
      const maxBytes = resolveSignalMaxBytes({
        cfg,
        accountId: accountId ?? undefined,
      });
      return await send(to, sanitizeOutboundText(text), {
        cfg,
        mediaUrl,
        maxBytes,
        accountId: accountId ?? undefined,
        mediaLocalRoots,
        mediaReadFile,
      });
    },
  }),
};
