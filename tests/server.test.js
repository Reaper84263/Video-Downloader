import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFormatSelector,
  formatBytes,
  getSiteExtractorArgs,
  isPrivateIp,
  looksLikeDirectMediaUrl,
  parseYtDlpProgress,
  pickBestFormats,
  safeFileName,
} from "../server.js";

test("detects direct video file URLs", () => {
  assert.equal(looksLikeDirectMediaUrl("https://cdn.example.com/watch/video.mp4"), true);
  assert.equal(looksLikeDirectMediaUrl("https://cdn.example.com/watch/video.webm?token=1"), true);
  assert.equal(looksLikeDirectMediaUrl("https://example.com/watch/12345"), false);
  assert.equal(looksLikeDirectMediaUrl("not a url"), false);
});

test("blocks private network addresses", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.2.4"), true);
  assert.equal(isPrivateIp("172.20.0.4"), true);
  assert.equal(isPrivateIp("192.168.1.5"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("::1"), true);
});

test("formats byte sizes", () => {
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(10485760), "10 MB");
  assert.equal(formatBytes(0), null);
});

test("sanitizes filenames for content disposition", () => {
  assert.equal(safeFileName('bad:file/name?.mp4'), "bad file name .mp4");
  assert.equal(safeFileName(""), "video");
});

test("offers every detected video quality including video-only formats", () => {
  const formats = pickBestFormats({
    formats: [
      { format_id: "18", ext: "mp4", height: 360, vcodec: "h264", acodec: "aac", filesize: 1000 },
      { format_id: "137", ext: "mp4", height: 1080, vcodec: "h264", acodec: "none", filesize: 2000 },
      { format_id: "22", ext: "mp4", height: 720, vcodec: "h264", acodec: "aac", filesize: 3000 },
    ],
  });

  assert.equal(formats[0].id, "auto");
  assert.deepEqual(
    formats.slice(1).map((format) => format.id),
    ["quality-1080", "quality-720", "quality-360"],
  );
});

test("builds a constrained yt-dlp selector for the chosen quality", () => {
  assert.match(buildFormatSelector("auto"), /bv\*/);
  assert.match(buildFormatSelector("quality-720"), /height<=720/);
  assert.throws(() => buildFormatSelector("quality-nope"), /Unsupported quality/);
});

test("uses browser impersonation only for hosts that require it", () => {
  assert.deepEqual(
    getSiteExtractorArgs("https://www.pornhub.com/view_video.php?viewkey=test"),
    ["--impersonate", "chrome"],
  );
  assert.deepEqual(getSiteExtractorArgs("https://example.com/video"), []);
  assert.deepEqual(getSiteExtractorArgs("https://pornhub.com.example.com/video"), []);
});

test("parses live yt-dlp progress output", () => {
  assert.deepEqual(
    parseYtDlpProgress("VDPROGRESS|524288|1048576|NA| 50.0%|2.0MiB/s|00:02"),
    {
      downloaded: 524288,
      total: 1048576,
      percent: 50,
      speed: "2.0MiB/s",
      eta: "00:02",
    },
  );
  assert.equal(parseYtDlpProgress("[download] starting"), null);
});
