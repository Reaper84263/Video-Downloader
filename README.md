# Video Downloader

A local web app inspired by the paste-and-download workflow on SmallSEOTools' video downloader. It supports direct public video file URLs out of the box and can inspect broader public video pages when `yt-dlp` is installed on the computer.

For extractor-supported pages, the app lists every detected resolution. It downloads the selected video and audio streams, merges them with FFmpeg, and returns one finished file. Direct media URLs keep their original quality.

## Run it

```bash
node server.js
```

Open `http://localhost:5173`.

No npm install is required for the app itself.

## Deploy on Render

Create a **Web Service**, not a Static Site. The frontend calls the Node API routes in `server.js`, so a static deploy will load the page but downloads will fail because `/api/*` is not running.

Use these Render settings:

```bash
Build Command: npm run setup
Start Command: npm start
```

Keep the service on **one instance**. Download progress and finished files are stored on that running server while the browser polls `/api/jobs/:id`; multiple instances can send a later poll to a different server that does not have the same job. The app also saves job metadata in the temp directory so completed jobs can be recovered if in-memory state is lost on the same instance.

`npm run setup` installs `yt-dlp` into the Render build for extractor-supported links. Direct `.mp4`, `.webm`, `.mov`, and `.m4v` links can work without it, but social/streaming pages need the setup step. You can set `YTDLP_CONCURRENT_FRAGMENTS` to tune download concurrency; the default is `8`. You can set `DOWNLOAD_JOB_DIR` if you want job files under a specific writable directory instead of the OS temp folder.

Some sites, including YouTube, may reject Render datacenter traffic with a "sign in to confirm you're not a bot" message. For videos your account is allowed to access, export a Netscape-format cookies.txt file from your browser and configure one of these Render environment variables:

```bash
YTDLP_COOKIES_BASE64=<base64 encoded cookies.txt>
YTDLP_COOKIES_FILE=/path/to/cookies.txt
YTDLP_COOKIES=<raw cookies.txt text with \n line breaks>
```

On Windows, you can create the base64 value with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt"))
```

Cookies are secrets. Do not commit `cookies.txt` to GitHub. DRM-protected, paywalled, private, and access-controlled videos are not supported.

On Render, YouTube links are held until cookies are configured, and the app status pill will show "YouTube cookies needed" or "YouTube ready." Set `YTDLP_REQUIRE_YOUTUBE_COOKIES=false` only for a deployment where YouTube works without cookies.

After adding or changing cookie environment variables on Render, redeploy or restart the service. If the browser still shows old wording such as "No download found" for a cookie error, hard-refresh the page once; core app assets are served with `no-store` so future deploys should update immediately.

If `yt-dlp` reports a Cloudflare anti-bot challenge or asks for `generic:impersonate`, the site is blocking automated server traffic. This app does not bypass anti-bot challenges. Use an official download/export option, a direct public media file URL, or another source you are allowed to access without that protection.

## Optional extractor support

Direct links such as `.mp4`, `.webm`, `.mov`, and `.m4v` work without extra tools. For public social or streaming URLs, install the project-local extractor and restart the server.

```bash
npm run setup
```

The server also detects `yt-dlp` installed globally, in a local `.venv`, or as a Python module. The setup command includes yt-dlp's browser-impersonation support for hosts that reject basic HTTP clients.

FFmpeg must be available on `PATH` for high-quality formats whose video and audio are served separately. Private, DRM-protected, paywalled, and login-only videos are not supported.

The app does not bypass logins, DRM, private videos, or copyright restrictions. Use it only for media you own or have permission to download.

## Scripts

```bash
npm test
npm start
```
