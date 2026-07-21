const form = document.querySelector("#downloadForm");
const input = document.querySelector("#videoUrl");
const pasteButton = document.querySelector("#pasteButton");
const tabs = document.querySelectorAll(".tab-button");
const extractorStatus = document.querySelector("#extractorStatus");
const emptyState = document.querySelector("#emptyState");
const loadingState = document.querySelector("#loadingState");
const messageState = document.querySelector("#messageState");
const videoResult = document.querySelector("#videoResult");
const thumbnail = document.querySelector("#thumbnail");
const sourceName = document.querySelector("#sourceName");
const videoTitle = document.querySelector("#videoTitle");
const modeBadge = document.querySelector("#modeBadge");
const formatList = document.querySelector("#formatList");

const placeholders = {
  any: "https://example.com/video.mp4",
  facebook: "https://www.facebook.com/watch/?v=...",
  instagram: "https://www.instagram.com/reel/...",
  tiktok: "https://www.tiktok.com/@user/video/...",
};

function extractVideoUrl(value) {
  const match = String(value || "").match(/https?:\/\/[^\s<>"']+/i);
  return (match?.[0] || String(value || "").trim()).replace(/[),.;!?]+$/, "");
}

function formatProgressBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function setPanel(state) {
  emptyState.classList.toggle("hidden", state !== "empty");
  loadingState.classList.toggle("hidden", state !== "loading");
  messageState.classList.toggle("hidden", state !== "message");
  videoResult.classList.toggle("hidden", state !== "result");
}

function messageTitleForTone(tone) {
  if (tone === "setup") {
    return "Extractor setup needed";
  }
  if (tone === "auth") {
    return "Cookies required";
  }
  if (tone === "blocked") {
    return "Site protection blocked this";
  }
  if (tone === "server") {
    return "Downloader server issue";
  }
  return "No download found";
}

function showMessage(message, tone = "error") {
  messageState.className = `message-state ${tone}`;
  messageState.innerHTML = "";

  const title = document.createElement("h2");
  title.textContent = messageTitleForTone(tone);

  const body = document.createElement("p");
  body.textContent = message;

  messageState.append(title, body);

  if (tone === "setup") {
    const command = document.createElement("code");
    command.className = "setup-command";
    command.textContent = "npm run setup";
    messageState.append(command);
  }
  setPanel("message");
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    extractorStatus.classList.toggle("ready", Boolean(data.ytdlp));
    extractorStatus.classList.toggle("limited", !data.ytdlp);
    extractorStatus.title = data.ytdlp && data.version ? `yt-dlp ${data.version}` : "Run npm run setup, then restart the app";
    extractorStatus.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${data.ytdlp ? "All links ready" : "Setup required"}`;
  } catch {
    extractorStatus.classList.add("limited");
    extractorStatus.innerHTML = '<span class="status-dot" aria-hidden="true"></span>Downloader API offline';
  }
}

function renderResult(data) {
  thumbnail.src = data.thumbnail || "/video-console.svg";
  thumbnail.alt = data.thumbnail ? `Thumbnail for ${data.title}` : "";
  sourceName.textContent = data.source || "Video source";
  videoTitle.textContent = data.title || "Untitled video";
  modeBadge.textContent = data.mode === "direct" ? "Direct file" : "Extractor";
  formatList.innerHTML = "";

  const qualityControl = document.createElement("div");
  qualityControl.className = "quality-control";

  const field = document.createElement("div");
  field.className = "quality-field";

  const label = document.createElement("label");
  label.htmlFor = "qualitySelect";
  label.textContent = "Video quality";

  const select = document.createElement("select");
  select.id = "qualitySelect";
  select.disabled = data.formats.length === 1;

  data.formats.forEach((format, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.dataset.meta = [format.extension?.toUpperCase(), format.size, format.note]
      .filter(Boolean)
      .join(" | ");
    option.textContent = format.label || "Original quality";
    select.append(option);
  });

  const meta = document.createElement("span");
  meta.className = "quality-meta";

  const downloadButton = document.createElement("button");
  downloadButton.className = "download-link";
  downloadButton.type = "button";
  downloadButton.textContent = "Download selected quality";

  const progressPanel = document.createElement("div");
  progressPanel.className = "download-progress hidden";

  const progressHeading = document.createElement("div");
  progressHeading.className = "progress-heading";
  const progressPhase = document.createElement("strong");
  progressPhase.textContent = "Preparing download";
  const progressPercent = document.createElement("span");
  progressPercent.textContent = "0%";
  progressHeading.append(progressPhase, progressPercent);

  const progressTrack = document.createElement("div");
  progressTrack.className = "progress-track";
  progressTrack.setAttribute("role", "progressbar");
  progressTrack.setAttribute("aria-label", "Video download progress");
  progressTrack.setAttribute("aria-valuemin", "0");
  progressTrack.setAttribute("aria-valuemax", "100");
  progressTrack.setAttribute("aria-valuenow", "0");
  const progressFill = document.createElement("span");
  progressTrack.append(progressFill);

  const progressFooter = document.createElement("div");
  progressFooter.className = "progress-footer";
  const progressStats = document.createElement("span");
  progressStats.textContent = "Waiting for the video host...";
  const cancelButton = document.createElement("button");
  cancelButton.className = "cancel-download";
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  progressFooter.append(progressStats, cancelButton);
  progressPanel.append(progressHeading, progressTrack, progressFooter);

  let activeJobId = null;
  let cancelRequested = false;

  const updateProgress = (job) => {
    const hasPercent = Number.isFinite(job.progress);
    const percent = hasPercent ? Math.max(0, Math.min(100, job.progress)) : 0;
    progressPhase.textContent = job.phase || "Downloading video";
    progressPercent.textContent = hasPercent ? `${Math.round(percent)}%` : "Working";
    progressFill.style.width = `${percent}%`;
    progressTrack.classList.toggle("indeterminate", !hasPercent);
    if (hasPercent) {
      progressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
    } else {
      progressTrack.removeAttribute("aria-valuenow");
    }

    const size = job.downloaded !== null
      ? [formatProgressBytes(job.downloaded), job.total ? formatProgressBytes(job.total) : null]
          .filter(Boolean)
          .join(" of ")
      : null;
    progressStats.textContent = [size, job.speed, job.eta ? `${job.eta} left` : null]
      .filter(Boolean)
      .join(" | ") || "Waiting for the video host...";
  };

  const updateSelection = () => {
    const option = select.selectedOptions[0];
    downloadButton.textContent = "Download selected quality";
    downloadButton.classList.remove("preparing");
    meta.textContent = option?.dataset.meta || "";
  };

  select.addEventListener("change", updateSelection);
  downloadButton.addEventListener("click", async () => {
    const selectedFormat = data.formats[Number(select.value)];
    if (!selectedFormat?.downloadRequest || activeJobId) {
      return;
    }

    cancelRequested = false;
    progressPanel.classList.remove("hidden", "error", "complete");
    downloadButton.classList.add("preparing");
    downloadButton.textContent = "Downloading...";
    downloadButton.disabled = true;
    select.disabled = true;
    cancelButton.disabled = false;
    progressPhase.textContent = "Starting download";
    progressPercent.textContent = "0%";
    progressFill.style.width = "0%";
    progressStats.textContent = "Connecting to the video host...";

    try {
      const startResponse = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selectedFormat.downloadRequest),
      });
      const startedJob = await startResponse.json();
      if (!startResponse.ok) {
        throw new Error(startedJob.message || "The download could not be started.");
      }

      activeJobId = startedJob.id;
      updateProgress(startedJob);

      while (!cancelRequested) {
        await wait(500);
        const jobResponse = await fetch(`/api/jobs/${activeJobId}`);
        const job = await jobResponse.json();
        if (!jobResponse.ok) {
          throw new Error(job.message || "The progress check failed.");
        }
        updateProgress(job);

        if (job.status === "ready") {
          progressPanel.classList.add("complete");
          const saveLink = document.createElement("a");
          saveLink.href = job.downloadUrl;
          saveLink.style.display = "none";
          document.body.append(saveLink);
          saveLink.click();
          saveLink.remove();
          break;
        }
        if (job.status === "error") {
          throw new Error(job.error || "The video could not be downloaded.");
        }
        if (job.status === "cancelled") {
          cancelRequested = true;
          break;
        }
      }
    } catch (error) {
      progressPanel.classList.add("error");
      progressPhase.textContent = "Download failed";
      progressPercent.textContent = "";
      progressStats.textContent = error.message || "The video could not be downloaded.";
    } finally {
      activeJobId = null;
      downloadButton.disabled = false;
      downloadButton.classList.remove("preparing");
      downloadButton.textContent = cancelRequested ? "Download selected quality" : "Download again";
      select.disabled = data.formats.length === 1;
      cancelButton.disabled = true;
    }
  });

  cancelButton.addEventListener("click", async () => {
    if (!activeJobId) {
      return;
    }
    cancelRequested = true;
    cancelButton.disabled = true;
    progressPhase.textContent = "Cancelling download";
    try {
      await fetch(`/api/jobs/${activeJobId}`, { method: "DELETE" });
    } finally {
      progressPanel.classList.remove("error", "complete");
      progressPhase.textContent = "Download cancelled";
      progressPercent.textContent = "";
      progressStats.textContent = "No file was saved.";
    }
  });
  updateSelection();
  field.append(label, select, meta);
  qualityControl.append(field, downloadButton);
  formatList.append(qualityControl, progressPanel);

  setPanel("result");
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((button) => {
      const active = button === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });

    input.placeholder = placeholders[tab.dataset.platform] || placeholders.any;
    input.focus();
  });
});

pasteButton.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      input.value = extractVideoUrl(text);
      input.focus();
    }
  } catch {
    showMessage("Clipboard access is not available in this browser.", "error");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = extractVideoUrl(input.value);
  if (!url) {
    input.focus();
    return;
  }
  input.value = url;

  setPanel("loading");

  try {
    const response = await fetch("/api/inspect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ url }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      showMessage(
        `The downloader API returned ${response.status || "an unreadable response"}. On Render, deploy this as a Web Service with npm start.`,
        "server",
      );
      return;
    }
    if (!response.ok || !data.ok) {
      const message = data.message || "This video could not be inspected.";
      const tone = data.tone || (response.status === 501
        ? "setup"
        : /cookies|sign in|not a bot|authentication/i.test(message)
          ? "auth"
          : /cloudflare|anti-bot|bot challenge|site blocked|protection|HTTP Error 403/i.test(message)
            ? "blocked"
          : "error");
      showMessage(message, tone);
      return;
    }

    renderResult(data);
  } catch {
    showMessage("The downloader server did not respond. On Render, check that the Web Service is running npm start.", "server");
  }
});

checkHealth();
