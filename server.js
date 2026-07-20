import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const port = Number(process.env.PORT || 5173);
const bodyLimit = 32 * 1024;
const ytdlpTimeoutMs = 45_000;
const downloadTimeoutMs = 30 * 60_000;
const jobRetentionMs = 60 * 60_000;
const maxActiveJobs = 3;
const concurrentFragmentDownloads = Math.max(
  1,
  Math.min(16, Number.parseInt(process.env.YTDLP_CONCURRENT_FRAGMENTS || "8", 10) || 8),
);
const directMediaExtensions = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".ogv",
  ".3gp",
]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
};

let cachedYtDlp = undefined;
const downloadJobs = new Map();

const ytDlpCandidates = process.platform === "win32"
  ? [
      { command: resolve(__dirname, ".venv", "Scripts", "yt-dlp.exe"), args: [] },
      { command: "yt-dlp", args: [] },
      { command: "python", args: ["-m", "yt_dlp"] },
    ]
  : [
      { command: resolve(__dirname, ".venv", "bin", "yt-dlp"), args: [] },
      { command: "yt-dlp", args: [] },
      { command: "python3", args: ["-m", "yt_dlp"] },
      { command: "python", args: ["-m", "yt_dlp"] },
    ];

export function looksLikeDirectMediaUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return directMediaExtensions.has(extname(parsed.pathname).toLowerCase());
  } catch {
    return false;
  }
}

export function isPrivateIp(address) {
  const version = net.isIP(address);
  if (!version) {
    return false;
  }

  if (version === 4) {
    const parts = address.split(".").map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }

  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function safeFileName(value, fallback = "video") {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return cleaned || fallback;
}

function encodeRfc5987Value(value) {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function asciiHeaderFileName(value, fallback) {
  const fileName = safeFileName(value, fallback);
  const extension = extname(fileName);
  const ascii = fileName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  if (ascii && !ascii.startsWith(".")) {
    return ascii;
  }

  const fallbackName = safeFileName(fallback, "video")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/^\.+/, "") || "video";
  return extension && extname(fallbackName).toLowerCase() !== extension.toLowerCase()
    ? `${fallbackName}${extension}`
    : fallbackName;
}

export function contentDispositionAttachment(value, fallback = "video") {
  const fileName = safeFileName(value, fallback);
  const fallbackName = asciiHeaderFileName(fileName, fallback);
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeRfc5987Value(fileName)}`;
}

export function pickBestFormats(info) {
  const rows = Array.isArray(info?.formats) ? info.formats : [];
  const heights = rows
    .filter((format) => {
      const hasVideo = format.vcodec && format.vcodec !== "none";
      const isBadProtocol = ["mhtml", "images"].includes(format.protocol);
      return hasVideo && !isBadProtocol && Number(format.height) > 0;
    })
    .map((format) => Number(format.height));

  const uniqueHeights = [...new Set(heights)].sort((a, b) => b - a).slice(0, 12);

  return [
    {
      id: "auto",
      label: "Best quality",
      extension: "mp4",
      height: null,
      size: null,
      note: "Highest video + audio",
    },
    ...uniqueHeights.map((height) => ({
      id: `quality-${height}`,
      label: `${height}p`,
      extension: "mp4",
      height,
      size: null,
      note: "Video + audio",
    })),
  ];
}

export function buildFormatSelector(formatKey) {
  if (!formatKey || formatKey === "auto") {
    return "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b";
  }

  const match = /^quality-(\d{2,4})$/.exec(formatKey);
  if (!match) {
    throw httpError(400, "Unsupported quality selection.");
  }

  const height = Number(match[1]);
  if (height < 100 || height > 4320) {
    throw httpError(400, "Unsupported quality selection.");
  }

  return [
    `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
    `b[height<=${height}][ext=mp4]`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}]`,
  ].join("/");
}

export function getSiteExtractorArgs(rawUrl) {
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  const needsImpersonation = ["pornhub.com", "thumbzilla.com"].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );

  return needsImpersonation ? ["--impersonate", "chrome"] : [];
}

export function parseYtDlpProgress(line) {
  const marker = "VDPROGRESS|";
  const markerIndex = String(line || "").indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const [downloadedRaw, totalRaw, estimateRaw, percentRaw, speedRaw, etaRaw] = String(line)
    .slice(markerIndex + marker.length)
    .trim()
    .split("|");
  const numeric = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const downloaded = numeric(downloadedRaw);
  const total = numeric(totalRaw) || numeric(estimateRaw);
  const parsedPercent = Number.parseFloat(percentRaw);
  const percent = Number.isFinite(parsedPercent)
    ? parsedPercent
    : downloaded !== null && total
      ? (downloaded / total) * 100
      : null;

  return {
    downloaded,
    total,
    percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
    speed: speedRaw && speedRaw !== "NA" ? speedRaw.trim() : null,
    eta: etaRaw && etaRaw !== "NA" ? etaRaw.trim() : null,
  };
}

export async function assertPublicHttpUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw httpError(400, "Enter a valid video URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw httpError(400, "Only HTTP and HTTPS video URLs are supported.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw httpError(400, "Local and private network URLs are blocked.");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw httpError(400, "Local and private network URLs are blocked.");
    }
    return parsed;
  }

  let records;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw httpError(422, "That host could not be reached.");
  }

  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw httpError(400, "Local and private network URLs are blocked.");
  }

  return parsed;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > bodyLimit) {
        rejectBody(httpError(413, "Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", rejectBody);
  });
}

async function readJsonBody(request) {
  const body = await readRequestBody(request);
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw httpError(400, "Send a valid JSON request.");
  }
}

async function fetchPublic(url, options = {}, redirects = 0) {
  const parsed = await assertPublicHttpUrl(url);
  const response = await fetch(parsed, {
    ...options,
    redirect: "manual",
    headers: {
      "user-agent": "VideoDownloader/1.0",
      ...(options.headers || {}),
    },
  });

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= 5) {
      throw httpError(508, "Too many redirects while fetching the video.");
    }

    const location = response.headers.get("location");
    if (!location) {
      throw httpError(502, "The video host redirected without a location.");
    }

    const nextUrl = new URL(location, parsed);
    return fetchPublic(nextUrl.href, options, redirects + 1);
  }

  return { response, finalUrl: parsed };
}

async function inspectDirectMedia(url) {
  let size = null;
  let contentType = "video/mp4";

  try {
    const { response } = await fetchPublic(url, { method: "HEAD" });
    if (response.ok) {
      size = formatBytes(Number(response.headers.get("content-length")));
      contentType = response.headers.get("content-type") || contentType;
    }
  } catch {
    // Some hosts reject HEAD requests. The download route still validates the URL.
  }

  const parsed = new URL(url);
  const extension = extname(parsed.pathname).replace(".", "").toLowerCase() || "mp4";
  const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "video");

  return {
    ok: true,
    mode: "direct",
    title: safeFileName(name, "Direct video"),
    source: parsed.hostname.replace(/^www\./, ""),
    thumbnail: null,
    formats: [
      {
        id: "direct",
        label: "Original file",
        extension,
        height: null,
        width: null,
        fps: null,
        size,
        note: contentType.split(";")[0],
        downloadUrl: `/api/proxy?url=${encodeURIComponent(url)}`,
        downloadRequest: {
          url,
          format: "direct",
          title: safeFileName(name, "video"),
        },
      },
    ],
  };
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      rejectProcess(httpError(504, "The video host took too long to respond."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        rejectProcess(httpError(501, "Install yt-dlp to inspect social or streaming links."));
        return;
      }
      rejectProcess(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }
      rejectProcess(httpError(422, stderr.trim() || "This URL could not be inspected."));
    });
  });
}

async function resolveYtDlp() {
  if (cachedYtDlp !== undefined) {
    return cachedYtDlp;
  }

  for (const candidate of ytDlpCandidates) {
    if (candidate.command.includes(__dirname)) {
      try {
        await access(candidate.command);
      } catch {
        continue;
      }
    }

    try {
      const result = await runProcess(candidate.command, [...candidate.args, "--version"], 8_000);
      cachedYtDlp = {
        ...candidate,
        version: result.stdout.trim(),
      };
      return cachedYtDlp;
    } catch {
      // Try the next supported executable or Python module.
    }
  }

  cachedYtDlp = null;
  return null;
}

async function runYtDlp(args, timeoutMs = ytdlpTimeoutMs) {
  const runner = await resolveYtDlp();
  if (!runner) {
    throw httpError(501, "The video extractor is not installed. Run npm.cmd run setup, then restart the app.");
  }

  return runProcess(runner.command, [...runner.args, ...args], timeoutMs);
}

async function inspectWithYtDlp(url) {
  const siteArgs = getSiteExtractorArgs(url);
  const { stdout } = await runYtDlp(
    [
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      "--no-warnings",
      "--ignore-config",
      ...siteArgs,
      url,
    ],
    ytdlpTimeoutMs,
  );

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw httpError(502, "The extractor returned an unreadable response.");
  }

  const formats = pickBestFormats(info).map((format) => ({
    ...format,
    downloadUrl: `/api/download?url=${encodeURIComponent(url)}&format=${encodeURIComponent(format.id)}&ext=${encodeURIComponent(format.extension)}&title=${encodeURIComponent(info.title || "video")}`,
    downloadRequest: {
      url,
      format: format.id,
      title: info.title || "video",
    },
  }));

  return {
    ok: true,
    mode: "extractor",
    title: info.title || "Untitled video",
    source: info.extractor_key || new URL(url).hostname.replace(/^www\./, ""),
    thumbnail: info.thumbnail || null,
    duration: info.duration_string || null,
    formats,
  };
}

async function inspectUrl(request, response) {
  const { url } = await readJsonBody(request);
  const parsed = await assertPublicHttpUrl(url);

  if (looksLikeDirectMediaUrl(parsed.href)) {
    sendJson(response, 200, await inspectDirectMedia(parsed.href));
    return;
  }

  sendJson(response, 200, await inspectWithYtDlp(parsed.href));
}

async function proxyDirectMedia(requestUrl, response) {
  const url = requestUrl.searchParams.get("url");
  const parsed = await assertPublicHttpUrl(url);

  if (!looksLikeDirectMediaUrl(parsed.href)) {
    throw httpError(400, "Direct downloads require a URL ending in a video file type.");
  }

  const { response: upstream } = await fetchPublic(parsed.href, { method: "GET" });
  if (!upstream.ok || !upstream.body) {
    throw httpError(502, "The video file could not be fetched.");
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const contentLength = upstream.headers.get("content-length");
  const filename = safeFileName(decodeURIComponent(parsed.pathname.split("/").pop() || "video"));

  response.writeHead(200, {
    "content-type": contentType,
    ...(contentLength ? { "content-length": contentLength } : {}),
    "content-disposition": contentDispositionAttachment(filename),
    "cache-control": "no-store",
  });

  await pipeline(Readable.fromWeb(upstream.body), response);
}

function activeJobCount() {
  return [...downloadJobs.values()].filter((job) =>
    ["queued", "downloading", "processing"].includes(job.status)).length;
}

function serializeJob(job) {
  return {
    ok: true,
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    downloaded: job.downloaded,
    total: job.total,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    downloadUrl: job.status === "ready" ? `/api/jobs/${job.id}/file` : null,
  };
}

function readableExtractorError(error) {
  const message = String(error?.message || "The download failed.")
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1)
    ?.replace(/^ERROR:\s*/i, "")
    .trim();
  return message || "The download failed.";
}

async function removeJobFiles(job) {
  if (!job.tempDir) {
    return;
  }
  const tempDir = job.tempDir;
  job.tempDir = null;
  job.output = null;
  await rm(tempDir, { recursive: true, force: true });
}

function scheduleJobRemoval(job, delay = jobRetentionMs) {
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    void removeJobFiles(job).finally(() => downloadJobs.delete(job.id));
  }, delay);
  job.cleanupTimer.unref?.();
}

async function findDownloadedFile(tempDir) {
  const files = (await readdir(tempDir))
    .filter((file) => !file.endsWith(".part") && !file.endsWith(".ytdl"));
  const candidates = await Promise.all(files.map(async (file) => {
    const path = join(tempDir, file);
    return { file, path, stats: await stat(path) };
  }));
  return candidates
    .filter((candidate) => candidate.stats.isFile())
    .sort((a, b) => b.stats.size - a.stats.size)[0] || null;
}

async function runDirectDownloadJob(job) {
  const controller = new AbortController();
  job.abortController = controller;
  const { response: upstream } = await fetchPublic(job.url, {
    method: "GET",
    signal: controller.signal,
  });

  if (!upstream.ok || !upstream.body) {
    throw httpError(502, "The video file could not be fetched.");
  }

  const parsed = new URL(job.url);
  const extension = extname(parsed.pathname).toLowerCase() || ".mp4";
  const outputPath = join(job.tempDir, `download${extension}`);
  const total = Number(upstream.headers.get("content-length")) || null;
  const startedAt = Date.now();

  job.total = total;
  job.phase = "Downloading video";

  const progressStream = new Transform({
    transform(chunk, _encoding, callback) {
      if (job.cancelled) {
        callback(httpError(499, "Download cancelled."));
        return;
      }

      job.downloaded += chunk.length;
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
      const bytesPerSecond = job.downloaded / elapsedSeconds;
      job.speed = `${formatBytes(bytesPerSecond) || "0 B"}/s`;
      job.progress = total ? Math.min(99, (job.downloaded / total) * 100) : null;
      job.eta = total && bytesPerSecond > 0
        ? `${Math.max(0, Math.ceil((total - job.downloaded) / bytesPerSecond))}s`
        : null;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(upstream.body),
      progressStream,
      createWriteStream(outputPath, { highWaterMark: 1024 * 1024 }),
    );
  } finally {
    job.abortController = null;
  }

  const stats = await stat(outputPath);
  job.output = {
    file: `download${extension}`,
    path: outputPath,
    stats,
    contentType: upstream.headers.get("content-type") || mimeTypes[extension] || "application/octet-stream",
  };
}

function runExtractorDownloadJob(job, runner, args) {
  return new Promise((resolveJob, rejectJob) => {
    const child = spawn(runner.command, [...runner.args, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.child = child;
    let stderr = "";
    const buffers = { stdout: "", stderr: "" };
    let settled = false;

    const handleLine = (line) => {
      const progress = parseYtDlpProgress(line);
      if (progress) {
        job.phase = "Downloading video";
        job.status = "downloading";
        job.downloaded = progress.downloaded;
        job.total = progress.total;
        job.progress = progress.percent === null ? job.progress : Math.min(98, progress.percent);
        job.speed = progress.speed;
        job.eta = progress.eta;
      } else if (/\[(?:Merger|VideoRemuxer|Fixup|Metadata)\]/i.test(line)) {
        job.status = "processing";
        job.phase = "Combining video and audio";
        job.progress = Math.max(job.progress || 0, 99);
        job.speed = null;
        job.eta = null;
      }
    };

    const consume = (name, chunk) => {
      const text = chunk.toString("utf8");
      if (name === "stderr") {
        stderr = `${stderr}${text}`.slice(-32_000);
      }
      buffers[name] += text;
      const lines = buffers[name].split(/\r?\n/);
      buffers[name] = lines.pop() || "";
      lines.forEach(handleLine);
    };

    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      rejectJob(httpError(504, "The video download took too long."));
    }, downloadTimeoutMs);

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectJob(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      handleLine(buffers.stdout);
      handleLine(buffers.stderr);
      if (job.cancelled) {
        rejectJob(httpError(499, "Download cancelled."));
      } else if (code === 0) {
        resolveJob();
      } else {
        rejectJob(httpError(422, stderr.trim() || "This video could not be downloaded."));
      }
    });
  });
}

async function runDownloadJob(job) {
  try {
    job.status = "downloading";
    job.phase = "Starting download";
    job.tempDir = await mkdtemp(join(tmpdir(), "video-downloader-job-"));

    if (looksLikeDirectMediaUrl(job.url)) {
      await runDirectDownloadJob(job);
    } else {
      const runner = await resolveYtDlp();
      if (!runner) {
        throw httpError(501, "The video extractor is not installed. Run npm.cmd run setup, then restart the app.");
      }

      const selector = buildFormatSelector(job.format);
      const outputTemplate = join(job.tempDir, "download.%(ext)s");
      const progressTemplate = "VDPROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s";
      await runExtractorDownloadJob(job, runner, [
        "-f",
        selector,
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--concurrent-fragments",
        String(concurrentFragmentDownloads),
        "--progress-template",
        `download:${progressTemplate}`,
        "--ignore-config",
        ...getSiteExtractorArgs(job.url),
        "--merge-output-format",
        "mp4",
        "-o",
        outputTemplate,
        job.url,
      ]);
      job.output = await findDownloadedFile(job.tempDir);
    }

    if (!job.output) {
      throw httpError(502, "The extractor finished without creating a video file.");
    }

    job.status = "ready";
    job.phase = "Ready to save";
    job.progress = 100;
    job.downloaded = job.output.stats.size;
    job.total = job.output.stats.size;
    job.speed = null;
    job.eta = null;
    scheduleJobRemoval(job);
  } catch (error) {
    await removeJobFiles(job);
    job.status = job.cancelled ? "cancelled" : "error";
    job.phase = job.cancelled ? "Download cancelled" : "Download failed";
    job.error = job.cancelled ? null : readableExtractorError(error);
    job.speed = null;
    job.eta = null;
    scheduleJobRemoval(job, 15 * 60_000);
  } finally {
    job.child = null;
    job.abortController = null;
  }
}

async function createDownloadJob(request, response) {
  if (activeJobCount() >= maxActiveJobs) {
    throw httpError(429, "Three downloads are already running. Wait for one to finish.");
  }

  const body = await readJsonBody(request);
  const parsed = await assertPublicHttpUrl(body.url);
  const direct = looksLikeDirectMediaUrl(parsed.href);
  const format = direct ? "direct" : String(body.format || "auto");
  if (!direct) {
    buildFormatSelector(format);
  }

  const job = {
    id: randomUUID(),
    url: parsed.href,
    format,
    title: safeFileName(body.title || "video"),
    status: "queued",
    phase: "Queued",
    progress: 0,
    downloaded: 0,
    total: null,
    speed: null,
    eta: null,
    error: null,
    output: null,
    tempDir: null,
    child: null,
    abortController: null,
    cancelled: false,
    cleanupTimer: null,
  };

  downloadJobs.set(job.id, job);
  sendJson(response, 202, serializeJob(job));
  setImmediate(() => void runDownloadJob(job));
}

function getDownloadJob(id) {
  const job = downloadJobs.get(id);
  if (!job) {
    throw httpError(404, "That download job no longer exists.");
  }
  return job;
}

async function sendDownloadJobFile(id, response) {
  const job = getDownloadJob(id);
  if (job.status !== "ready" || !job.output) {
    throw httpError(409, "This download is not ready yet.");
  }

  const extension = extname(job.output.file).toLowerCase() || ".mp4";
  const filename = extname(job.title).toLowerCase() === extension
    ? job.title
    : `${job.title}${extension}`;
  response.writeHead(200, {
    "content-type": job.output.contentType || mimeTypes[extension] || "application/octet-stream",
    "content-length": job.output.stats.size,
    "content-disposition": contentDispositionAttachment(filename, `video${extension}`),
    "cache-control": "no-store",
  });
  scheduleJobRemoval(job, 5 * 60_000);
  await pipeline(createReadStream(job.output.path), response);
}

async function cancelDownloadJob(id, response) {
  const job = getDownloadJob(id);
  if (!["ready", "error", "cancelled"].includes(job.status)) {
    job.cancelled = true;
    job.child?.kill("SIGKILL");
    job.abortController?.abort();
    job.status = "cancelled";
    job.phase = "Download cancelled";
    job.speed = null;
    job.eta = null;
    await removeJobFiles(job);
    scheduleJobRemoval(job, 5 * 60_000);
  }
  sendJson(response, 200, serializeJob(job));
}

async function downloadWithYtDlp(requestUrl, response) {
  const url = requestUrl.searchParams.get("url");
  const formatKey = requestUrl.searchParams.get("format") || "auto";
  const title = safeFileName(requestUrl.searchParams.get("title") || "video");
  const parsed = await assertPublicHttpUrl(url);

  const runner = await resolveYtDlp();
  if (!runner) {
    throw httpError(501, "The video extractor is not installed. Run npm.cmd run setup, then restart the app.");
  }

  const selector = buildFormatSelector(formatKey);
  const siteArgs = getSiteExtractorArgs(parsed.href);
  const tempDir = await mkdtemp(join(tmpdir(), "video-downloader-"));
  const outputTemplate = join(tempDir, "download.%(ext)s");

  try {
    await runProcess(
      runner.command,
      [
        ...runner.args,
        "-f",
        selector,
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--concurrent-fragments",
        String(concurrentFragmentDownloads),
        "--ignore-config",
        ...siteArgs,
        "--merge-output-format",
        "mp4",
        "-o",
        outputTemplate,
        parsed.href,
      ],
      downloadTimeoutMs,
    );

    const files = (await readdir(tempDir))
      .filter((file) => !file.endsWith(".part") && !file.endsWith(".ytdl"));

    if (!files.length) {
      throw httpError(502, "The extractor finished without creating a video file.");
    }

    const candidates = await Promise.all(files.map(async (file) => {
      const path = join(tempDir, file);
      return { file, path, stats: await stat(path) };
    }));
    const output = candidates
      .filter((candidate) => candidate.stats.isFile())
      .sort((a, b) => b.stats.size - a.stats.size)[0];

    if (!output) {
      throw httpError(502, "The extractor finished without creating a video file.");
    }

    const extension = extname(output.file).toLowerCase() || ".mp4";
    response.writeHead(200, {
      "content-type": mimeTypes[extension] || "application/octet-stream",
      "content-length": output.stats.size,
      "content-disposition": contentDispositionAttachment(`${title}${extension}`, `video${extension}`),
      "cache-control": "no-store",
    });
    await pipeline(createReadStream(output.path), response);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function serveStatic(requestUrl, response) {
  const pathname = decodeURIComponent(requestUrl.pathname);
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicDir, requestedPath));
  const relativePath = relative(publicDir, filePath);

  if (relativePath.startsWith("..") || relativePath.includes("..\\")) {
    throw httpError(403, "Forbidden.");
  }

  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    throw httpError(404, "Not found.");
  }

  response.writeHead(200, {
    "content-type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
    "content-length": fileStats.size,
    "cache-control": requestedPath === "/index.html" ? "no-store" : "public, max-age=3600",
  });
  createReadStream(filePath).pipe(response);
}

export async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "POST" && requestUrl.pathname === "/api/inspect") {
      await inspectUrl(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/jobs") {
      await createDownloadJob(request, response);
      return;
    }

    const jobRoute = /^\/api\/jobs\/([a-f0-9-]+)(\/file)?$/.exec(requestUrl.pathname);
    if (jobRoute && request.method === "GET" && jobRoute[2] === "/file") {
      await sendDownloadJobFile(jobRoute[1], response);
      return;
    }

    if (jobRoute && request.method === "GET") {
      sendJson(response, 200, serializeJob(getDownloadJob(jobRoute[1])));
      return;
    }

    if (jobRoute && request.method === "DELETE") {
      await cancelDownloadJob(jobRoute[1], response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/proxy") {
      await proxyDirectMedia(requestUrl, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/download") {
      await downloadWithYtDlp(requestUrl, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      const ytDlp = await resolveYtDlp();
      sendJson(response, 200, {
        ok: true,
        ytdlp: Boolean(ytDlp),
        version: ytDlp?.version || null,
      });
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(requestUrl, response);
      return;
    }

    throw httpError(405, "Method not allowed.");
  } catch (error) {
    const status = error.status || (error.code === "ENOENT" ? 404 : 500);
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    sendJson(response, status, {
      ok: false,
      message: error.message || "Something went wrong.",
    });
  }
}

export function startServer() {
  const server = createServer(handleRequest);
  server.listen(port, () => {
    console.log(`Video Downloader running at http://localhost:${port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
