// Shows the clip written by ComfyUI-H3-ClipPreview while an H3 prompt samples.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EVENT = "h3_clip_preview";
let panel = null;
let video = null;
let label = null;
let activePrompt = null;

function build() {
  if (panel) return;
  panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:1000;width:320px;max-width:40vw;display:none;" +
    "background:#111;border:1px solid #444;border-radius:6px;overflow:hidden;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.5);font:12px sans-serif;color:#ddd";
  video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.style.cssText = "display:block;width:100%;background:#000";
  label = document.createElement("div");
  label.style.cssText = "padding:4px 8px;display:flex;justify-content:space-between";
  panel.append(video, label);
  document.body.appendChild(panel);
}

function hide() {
  activePrompt = null;
  if (!panel) return;
  panel.style.display = "none";
  video.removeAttribute("src");
  video.load();
}

function show({ prompt_id, step, total, filename, subfolder }) {
  build();
  activePrompt = prompt_id;
  const params = new URLSearchParams({ filename, subfolder: subfolder || "", type: "output", t: String(Date.now()) });
  const t = video.currentTime;
  video.src = api.apiURL(`/view?${params}`);
  video.addEventListener("loadedmetadata", () => {
    // Keep the playhead where it was so a refreshed clip does not restart the loop.
    if (t && video.duration) video.currentTime = Math.min(t, video.duration - 0.05);
    video.play().catch(() => {});
  }, { once: true });
  label.textContent = "";
  const a = document.createElement("span");
  a.textContent = "H3 clip preview";
  const b = document.createElement("span");
  b.textContent = `step ${step}/${total}`;
  label.append(a, b);
  panel.style.display = "block";
}

app.registerExtension({
  name: "H3.ClipPreview",
  setup() {
    api.addEventListener(EVENT, (e) => show(e.detail));
    // The clip belongs to the sampling stage; the real decode replaces it.
    for (const ev of ["execution_success", "execution_error", "execution_interrupted"]) {
      api.addEventListener(ev, (e) => {
        if (!activePrompt || !e.detail || e.detail.prompt_id === activePrompt) hide();
      });
    }
  },
});
