import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const venvDir = resolve(root, ".venv");
const python = process.platform === "win32"
  ? resolve(venvDir, "Scripts", "python.exe")
  : resolve(venvDir, "bin", "python");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (!existsSync(python)) {
  const systemPython = process.platform === "win32" ? "python" : "python3";
  console.log("Creating a project-local Python environment...");
  run(systemPython, ["-m", "venv", venvDir]);
}

console.log("Installing the video extractor...");
run(python, ["-m", "pip", "install", "--upgrade", "pip", "yt-dlp[default,curl-cffi]"]);
console.log("Extractor ready. Restart the downloader server.");
