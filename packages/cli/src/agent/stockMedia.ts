/**
 * Stock-media providers (Pexels, Unsplash, Pixabay) for the in-Studio agent.
 *
 * - `search()` hits the chosen provider's search API and returns a uniform
 *   list of results the agent can pick from.
 * - `download()` resolves the canonical download URL (handling Unsplash's
 *   download-tracking handshake) and streams the asset to disk.
 *
 * Keys come from `credentials.ts` (env var first, then on-disk file). The
 * agent never sees the raw key — it just calls these helpers via the MCP
 * tools in `tools.ts`.
 */

import { getStockApiKey, type StockProvider } from "./credentials.js";

export type StockMediaKind = "photo" | "video";
export type StockOrientation = "landscape" | "portrait" | "square";

export interface StockSearchOptions {
  provider: StockProvider;
  query: string;
  kind: StockMediaKind;
  perPage?: number;
  orientation?: StockOrientation;
}

export interface StockSearchResult {
  provider: StockProvider;
  kind: StockMediaKind;
  id: string;
  /** Direct URL the agent should pass to download() (may be a tracking URL). */
  downloadUrl: string;
  /** Lightweight preview URL — useful when the agent reports back to the user. */
  previewUrl?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  author?: string;
  authorUrl?: string;
  /** Provider page (for attribution). */
  pageUrl?: string;
  description?: string;
  /** Best file extension to use when saving. */
  suggestedExtension: string;
}

const UNSPLASH_PHOTO_HOSTS = new Set(["images.unsplash.com", "plus.unsplash.com"]);
const PEXELS_MEDIA_HOSTS = new Set(["images.pexels.com", "videos.pexels.com", "player.vimeo.com"]);
const PIXABAY_MEDIA_HOSTS = new Set(["pixabay.com", "cdn.pixabay.com", "i.pixabay.com"]);

function assertKey(provider: StockProvider): string {
  const key = getStockApiKey(provider);
  if (!key) {
    throw new Error(
      `${provider} is not configured. Ask the user to paste a ${provider} API key in Studio → AI panel → Settings → Stock media.`,
    );
  }
  return key;
}

function clampPerPage(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 6;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function inferExtensionFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\.([a-zA-Z0-9]{2,5})(?:$|\?)/);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    /* ignore */
  }
  return fallback;
}

// ── Search ────────────────────────────────────────────────────────────────

export async function search(opts: StockSearchOptions): Promise<StockSearchResult[]> {
  const perPage = clampPerPage(opts.perPage);
  const query = opts.query.trim();
  if (!query) throw new Error("query is required.");

  switch (opts.provider) {
    case "pexels":
      return searchPexels(opts.kind, query, perPage, opts.orientation);
    case "unsplash":
      return searchUnsplash(opts.kind, query, perPage, opts.orientation);
    case "pixabay":
      return searchPixabay(opts.kind, query, perPage, opts.orientation);
    default: {
      const exhaustive: never = opts.provider;
      throw new Error(`unknown provider: ${String(exhaustive)}`);
    }
  }
}

interface PexelsPhotoResponse {
  photos: Array<{
    id: number;
    width: number;
    height: number;
    url: string;
    photographer: string;
    photographer_url: string;
    alt?: string;
    src: { original: string; large2x: string; large: string; medium: string };
  }>;
}

interface PexelsVideoResponse {
  videos: Array<{
    id: number;
    width: number;
    height: number;
    duration: number;
    url: string;
    image: string;
    user: { name: string; url: string };
    video_files: Array<{
      link: string;
      width: number;
      height: number;
      file_type: string;
      quality: string;
    }>;
  }>;
}

async function searchPexels(
  kind: StockMediaKind,
  query: string,
  perPage: number,
  orientation: StockOrientation | undefined,
): Promise<StockSearchResult[]> {
  const key = assertKey("pexels");
  const params = new URLSearchParams({ query, per_page: String(perPage) });
  if (orientation) params.set("orientation", orientation);
  const endpoint =
    kind === "photo"
      ? `https://api.pexels.com/v1/search?${params.toString()}`
      : `https://api.pexels.com/videos/search?${params.toString()}`;
  const res = await fetch(endpoint, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`Pexels search failed (HTTP ${res.status}).`);

  if (kind === "photo") {
    const data = (await res.json()) as PexelsPhotoResponse;
    return data.photos.map((p) => ({
      provider: "pexels",
      kind,
      id: String(p.id),
      downloadUrl: p.src.original,
      previewUrl: p.src.medium,
      width: p.width,
      height: p.height,
      author: p.photographer,
      authorUrl: p.photographer_url,
      pageUrl: p.url,
      description: p.alt,
      suggestedExtension: inferExtensionFromUrl(p.src.original, "jpg"),
    }));
  }

  const data = (await res.json()) as PexelsVideoResponse;
  return data.videos.map((v) => {
    const file = pickBestPexelsVideoFile(v.video_files);
    return {
      provider: "pexels",
      kind,
      id: String(v.id),
      downloadUrl: file.link,
      previewUrl: v.image,
      width: file.width || v.width,
      height: file.height || v.height,
      durationSeconds: v.duration,
      author: v.user.name,
      authorUrl: v.user.url,
      pageUrl: v.url,
      suggestedExtension: inferExtensionFromUrl(file.link, "mp4"),
    };
  });
}

function pickBestPexelsVideoFile(
  files: PexelsVideoResponse["videos"][number]["video_files"],
): PexelsVideoResponse["videos"][number]["video_files"][number] {
  // Prefer HD .mp4 around 1080p; fall back to the first file the API returned.
  const mp4 = files.filter((f) => f.file_type === "video/mp4");
  const pool = mp4.length ? mp4 : files;
  const sorted = [...pool].sort((a, b) => {
    const aHD = a.quality === "hd" ? 0 : 1;
    const bHD = b.quality === "hd" ? 0 : 1;
    if (aHD !== bHD) return aHD - bHD;
    return Math.abs((b.height || 0) - 1080) - Math.abs((a.height || 0) - 1080);
  });
  return sorted[0] ?? files[0]!;
}

interface UnsplashPhotoResponse {
  results: Array<{
    id: string;
    width: number;
    height: number;
    description: string | null;
    alt_description: string | null;
    urls: { raw: string; full: string; regular: string; small: string };
    user: { name: string; links: { html: string } };
    links: { html: string; download: string; download_location: string };
  }>;
}

async function searchUnsplash(
  kind: StockMediaKind,
  query: string,
  perPage: number,
  orientation: StockOrientation | undefined,
): Promise<StockSearchResult[]> {
  if (kind === "video") {
    throw new Error("Unsplash only provides photos. Use pexels or pixabay for video searches.");
  }
  const key = assertKey("unsplash");
  const params = new URLSearchParams({ query, per_page: String(perPage) });
  if (orientation) {
    // Unsplash uses landscape/portrait/squarish.
    params.set("orientation", orientation === "square" ? "squarish" : orientation);
  }
  const res = await fetch(`https://api.unsplash.com/search/photos?${params.toString()}`, {
    headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
  });
  if (!res.ok) throw new Error(`Unsplash search failed (HTTP ${res.status}).`);
  const data = (await res.json()) as UnsplashPhotoResponse;
  return data.results.map((p) => ({
    provider: "unsplash",
    kind,
    id: p.id,
    // Use the tracking endpoint — download() resolves it through the
    // Unsplash API to register the download per Unsplash's API terms.
    downloadUrl: p.links.download_location,
    previewUrl: p.urls.small,
    width: p.width,
    height: p.height,
    author: p.user.name,
    authorUrl: p.user.links.html,
    pageUrl: p.links.html,
    description: p.description ?? p.alt_description ?? undefined,
    suggestedExtension: "jpg",
  }));
}

interface PixabayPhotoResponse {
  hits: Array<{
    id: number;
    pageURL: string;
    tags: string;
    user: string;
    imageWidth: number;
    imageHeight: number;
    webformatURL: string;
    largeImageURL: string;
  }>;
}

interface PixabayVideoResponse {
  hits: Array<{
    id: number;
    pageURL: string;
    tags: string;
    user: string;
    duration: number;
    picture_id: string;
    videos: Record<
      string,
      { url: string; width: number; height: number; size: number; thumbnail?: string }
    >;
  }>;
}

async function searchPixabay(
  kind: StockMediaKind,
  query: string,
  perPage: number,
  orientation: StockOrientation | undefined,
): Promise<StockSearchResult[]> {
  const key = assertKey("pixabay");
  const params = new URLSearchParams({
    key,
    q: query,
    per_page: String(Math.max(3, perPage)), // Pixabay requires per_page >= 3
    safesearch: "true",
  });
  if (orientation && kind === "photo") {
    params.set("orientation", orientation === "square" ? "all" : orientation);
  }

  if (kind === "photo") {
    params.set("image_type", "photo");
    const res = await fetch(`https://pixabay.com/api/?${params.toString()}`);
    if (!res.ok) throw new Error(`Pixabay search failed (HTTP ${res.status}).`);
    const data = (await res.json()) as PixabayPhotoResponse;
    return data.hits.map((h) => ({
      provider: "pixabay",
      kind,
      id: String(h.id),
      downloadUrl: h.largeImageURL,
      previewUrl: h.webformatURL,
      width: h.imageWidth,
      height: h.imageHeight,
      author: h.user,
      pageUrl: h.pageURL,
      description: h.tags,
      suggestedExtension: inferExtensionFromUrl(h.largeImageURL, "jpg"),
    }));
  }

  const res = await fetch(`https://pixabay.com/api/videos/?${params.toString()}`);
  if (!res.ok) throw new Error(`Pixabay search failed (HTTP ${res.status}).`);
  const data = (await res.json()) as PixabayVideoResponse;
  return data.hits.map((h) => {
    const file = pickBestPixabayVideoFile(h.videos);
    return {
      provider: "pixabay",
      kind,
      id: String(h.id),
      downloadUrl: file.url,
      previewUrl: file.thumbnail,
      width: file.width,
      height: file.height,
      durationSeconds: h.duration,
      author: h.user,
      pageUrl: h.pageURL,
      description: h.tags,
      suggestedExtension: inferExtensionFromUrl(file.url, "mp4"),
    };
  });
}

function pickBestPixabayVideoFile(
  videos: PixabayVideoResponse["hits"][number]["videos"],
): PixabayVideoResponse["hits"][number]["videos"][string] {
  // Pixabay buckets are `large` > `medium` > `small` > `tiny`. Pick the
  // first one that actually has a populated URL.
  for (const bucket of ["large", "medium", "small", "tiny"]) {
    const file = videos[bucket];
    if (file?.url) return file;
  }
  const first = Object.values(videos).find((v) => v?.url);
  if (!first) throw new Error("Pixabay video result has no downloadable files.");
  return first;
}

// ── Download ──────────────────────────────────────────────────────────────

export interface DownloadResult {
  bytes: number;
  finalUrl: string;
  contentType: string | null;
}

export async function download(
  url: string,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; meta: DownloadResult }> {
  const initial = new URL(url);
  let resolved = initial;

  // Unsplash's download_location returns a JSON `{url}` pointing at the
  // real image. Hitting it registers the download for the photographer's
  // analytics, which is required by Unsplash's API terms.
  if (initial.hostname === "api.unsplash.com") {
    const key = assertKey("unsplash");
    const meta = await fetch(initial.toString(), {
      headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
      signal,
    });
    if (!meta.ok) {
      throw new Error(`Unsplash download handshake failed (HTTP ${meta.status}).`);
    }
    const json = (await meta.json()) as { url?: string };
    if (!json.url) throw new Error("Unsplash response did not include a download URL.");
    resolved = new URL(json.url);
  }

  if (!isAllowedMediaHost(resolved.hostname)) {
    throw new Error(
      `Refusing to download from untrusted host "${resolved.hostname}". Only Pexels, Unsplash, and Pixabay media hosts are allowed.`,
    );
  }

  const res = await fetch(resolved.toString(), { signal });
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}) for ${resolved.toString()}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  return {
    buffer,
    meta: {
      bytes: buffer.length,
      finalUrl: resolved.toString(),
      contentType: res.headers.get("content-type"),
    },
  };
}

function isAllowedMediaHost(hostname: string): boolean {
  if (UNSPLASH_PHOTO_HOSTS.has(hostname)) return true;
  if (PEXELS_MEDIA_HOSTS.has(hostname)) return true;
  if (PIXABAY_MEDIA_HOSTS.has(hostname)) return true;
  // Some Pexels video links live on additional subdomains (e.g. videocdn).
  if (hostname.endsWith(".pexels.com")) return true;
  if (hostname.endsWith(".pixabay.com")) return true;
  if (hostname.endsWith(".unsplash.com")) return true;
  return false;
}

export function formatSearchResults(results: StockSearchResult[]): string {
  if (results.length === 0) return "(no results)";
  return results
    .map((r, i) => {
      const dims = r.width && r.height ? `${r.width}x${r.height}` : "unknown";
      const dur = r.durationSeconds != null ? ` · ${Math.round(r.durationSeconds)}s` : "";
      const author = r.author ? ` · by ${r.author}` : "";
      const desc = r.description ? ` — ${truncate(r.description, 80)}` : "";
      return [
        `[${i + 1}] ${r.provider}:${r.id} (${r.kind}, ${dims}${dur})${author}${desc}`,
        `    download: ${r.downloadUrl}`,
        r.previewUrl ? `    preview:  ${r.previewUrl}` : null,
        r.pageUrl ? `    page:     ${r.pageUrl}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
