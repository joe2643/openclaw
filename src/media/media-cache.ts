import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";
import type { MediaKind } from "./constants.js";
import { mediaKindFromMime } from "./constants.js";
import { extensionForMime, normalizeMimeType } from "./mime.js";

export const MEDIA_CACHE_SUBDIR = "cache";
export const CACHED_MEDIA_MARKER_PREFIX = "[media cached: ";

const MEDIA_FILE_MODE = 0o644;
const MEDIA_DIR_MODE = 0o700;

function resolveCacheDir(): string {
  return path.join(resolveConfigDir(), "media", MEDIA_CACHE_SUBDIR);
}

/**
 * Cache a media content block (base64) to disk for later retrieval.
 *
 * Uses a SHA-256 content hash (truncated to 16 hex chars) combined with the file
 * extension derived from the MIME type as the cache key. Identical content with the
 * same MIME type always maps to the same file; different MIME types produce different
 * cache entries even for identical bytes.
 *
 * @returns The absolute path and hash of the cached file.
 */
export async function cacheMediaToDisk(
  data: string,
  mimeType: string,
): Promise<{ path: string; hash: string }> {
  const buffer = Buffer.from(data, "base64");
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const ext = extensionForMime(mimeType) ?? "";
  const fileName = `${hash}${ext}`;
  const dir = resolveCacheDir();
  const filePath = path.join(dir, fileName);

  // Fast path: return immediately if the file is already present.
  // The atomic rename below is the authoritative race-free write path.
  try {
    await fs.access(filePath);
    return { path: filePath, hash };
  } catch {
    // File doesn't exist yet; proceed with write.
  }

  await fs.mkdir(dir, { recursive: true, mode: MEDIA_DIR_MODE });

  // Write to a unique temp file then rename atomically. This eliminates the TOCTOU
  // window: a concurrent writer that races past the access() check above can never
  // observe a partially-written file at filePath — rename(2) on POSIX is atomic and
  // silently replaces any already-complete file written by the racing writer.
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmpPath, buffer, { mode: MEDIA_FILE_MODE });
    await fs.rename(tmpPath, filePath);
  } catch {
    await fs.unlink(tmpPath).catch(() => {});
    // rename may fail on Windows (EEXIST/EPERM) if a concurrent write already landed
    // the final file. Confirm the target exists before returning.
    await fs.access(filePath);
  }
  return { path: filePath, hash };
}

/**
 * Build a cached media marker string for embedding in pruned message text.
 *
 * Format: `[media cached: <path> (<mimeType>) kind=<kind>]`
 *
 * The MIME type is normalized (lowercased, parameters stripped) so the marker is
 * consistent regardless of how the caller received the Content-Type header.
 */
export function buildCachedMediaMarker(
  filePath: string,
  mimeType: string,
  kind: MediaKind,
): string {
  const normalizedMime = normalizeMimeType(mimeType) ?? mimeType;
  return `${CACHED_MEDIA_MARKER_PREFIX}${filePath} (${normalizedMime}) kind=${kind}]`;
}

/**
 * Derive the MediaKind for a given MIME type, defaulting to "document" for unknown types.
 *
 * The MIME string is normalized before matching so values like `image/png; charset=binary`
 * or `IMAGE/PNG` are correctly classified as `"image"` rather than falling back to
 * `"document"`.
 */
export function mediaCacheKind(mimeType: string): MediaKind {
  return mediaKindFromMime(normalizeMimeType(mimeType)) ?? "document";
}
