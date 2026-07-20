# Video Downloader

A local web app inspired by the paste-and-download workflow on SmallSEOTools' video downloader. It supports direct public video file URLs out of the box and can inspect broader public video pages when `yt-dlp` is installed on the computer.

For extractor-supported pages, the app lists every detected resolution. It downloads the selected video and audio streams, merges them with FFmpeg, and returns one finished file. Direct media URLs keep their original quality.

## Run it

```bash
node server.js
```

Open `http://localhost:5173`.

No npm install is required for the app itself.

## Optional extractor support

Direct links such as `.mp4`, `.webm`, `.mov`, and `.m4v` work without extra tools. For public social or streaming URLs, install the project-local extractor and restart the server.

```bash
npm.cmd run setup
```

The server also detects `yt-dlp` installed globally, in a local `.venv`, or as a Python module. The setup command includes yt-dlp's browser-impersonation support for hosts that reject basic HTTP clients.

FFmpeg must be available on `PATH` for high-quality formats whose video and audio are served separately. Private, DRM-protected, paywalled, and login-only videos are not supported.

The app does not bypass logins, DRM, private videos, or copyright restrictions. Use it only for media you own or have permission to download.

## Scripts

```bash
npm.cmd test
npm.cmd start
```
