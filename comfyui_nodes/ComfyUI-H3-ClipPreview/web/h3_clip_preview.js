// Plays the clip written by ComfyUI-H3-ClipPreview on the node that is sampling, like the built-in
// image preview does. If that node cannot be found (inside a subgraph, say) a small panel at the
// bottom right of the window shows it instead.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EVENT = "h3_clip_preview";
const WIDGET = "h3_clip_preview";

let executingNode = null; // id of the node ComfyUI says it is running
let activePrompt = null;
let host = null; // { node, widget, video, label } or { panel, video, label }

function makeVideo() {
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;background:#000";
  return video;
}

function makeBox(video) {
  const box = document.createElement("div");
  box.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;background:#000;overflow:hidden";
  const label = document.createElement("div");
  label.style.cssText = "font:11px sans-serif;color:#bbb;padding:2px 6px;display:flex;justify-content:space-between";
  video.style.flex = "1 1 auto";
  video.style.minHeight = "0";
  box.append(video, label);
  return { box, label };
}

function findNode(id) {
  if (id == null) return null;
  const graph = app.graph;
  const node = graph?.getNodeById?.(Number(id)) ?? graph?._nodes_by_id?.[id];
  return node || null;
}

function release() {
  if (!host) return;
  host.video.removeAttribute("src");
  host.video.load();
  if (host.node) {
    const node = host.node;
    cancelAnimationFrame(host.raf);
    const i = node.widgets ? node.widgets.indexOf(host.widget) : -1;
    if (i >= 0) node.widgets.splice(i, 1);
    const keep = host.sizeBefore;
    if (keep) node.setSize([Math.max(node.size[0], keep[0]), keep[1]]);
    node.graph?.setDirtyCanvas?.(true, true);
  } else if (host.panel) {
    host.panel.remove();
  }
  host = null;
}

function attachToNode(node) {
  // Drawn on the node's own canvas (as the built-in image preview is), so it follows zoom and pan
  // and never floats above other nodes.
  const video = makeVideo();
  const state = { step: 0, total: 0 };
  const widget = {
    name: WIDGET,
    type: WIDGET,
    value: null,
    serialize: false,
    options: { serialize: false },
    computeSize: (width) => [width, 180],
    draw(ctx, n, width, y) {
      const pad = 8;
      const labelH = 14;
      const boxW = width - pad * 2;
      // The layout hands a custom widget one row of height; the picture takes the rest of the node.
      const boxH = Math.max(40, n.size[1] - y - pad - labelH);
      ctx.save();
      ctx.fillStyle = "#000";
      ctx.fillRect(pad, y, boxW, boxH);
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(boxW / video.videoWidth, boxH / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        ctx.drawImage(video, pad + (boxW - w) / 2, y + (boxH - h) / 2, w, h);
      }
      ctx.fillStyle = "#bbb";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText("H3 clip preview", pad, y + boxH + 2);
      ctx.textAlign = "right";
      ctx.fillText(`step ${state.step}/${state.total}`, width - pad, y + boxH + 2);
      ctx.restore();
    },
  };
  node.addCustomWidget ? node.addCustomWidget(widget) : (node.widgets ||= []).push(widget);
  const sizeBefore = [...node.size];
  const need = node.computeSize();
  if (node.size[1] < need[1]) node.setSize([node.size[0], need[1]]);
  host = { node, widget, video, state, sizeBefore, raf: 0 };
  const tick = () => {
    if (!host || host.widget !== widget) return;
    node.graph?.setDirtyCanvas?.(true, false);
    host.raf = requestAnimationFrame(tick);
  };
  host.raf = requestAnimationFrame(tick);
}

function attachPanel() {
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:1000;width:320px;max-width:40vw;background:#111;" +
    "border:1px solid #444;border-radius:6px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.5)";
  const video = makeVideo();
  video.style.height = "auto";
  const { box, label } = makeBox(video);
  box.style.height = "auto";
  panel.append(box);
  document.body.appendChild(panel);
  host = { panel, video, label };
}

function show({ prompt_id, step, total, filename, subfolder }) {
  if (activePrompt !== prompt_id) {
    release();
    activePrompt = prompt_id;
  }
  if (!host || (host.node && host.node.id !== Number(executingNode))) {
    release();
    const node = findNode(executingNode);
    node ? attachToNode(node) : attachPanel();
  }
  const { video, label } = host;
  if (host.state) {
    host.state.step = step;
    host.state.total = total;
  }
  const params = new URLSearchParams({ filename, subfolder: subfolder || "", type: "output", t: String(Date.now()) });
  const t = video.currentTime;
  video.src = api.apiURL(`/view?${params}`);
  video.addEventListener("loadedmetadata", () => {
    // Keep the playhead where it was so a refreshed clip does not restart the loop.
    if (t && video.duration) video.currentTime = Math.min(t, video.duration - 0.05);
    video.play().catch(() => {});
  }, { once: true });
  if (label) {
    label.textContent = "";
    const a = document.createElement("span");
    a.textContent = "H3 clip preview";
    const b = document.createElement("span");
    b.textContent = `step ${step}/${total}`;
    label.append(a, b);
  }
}

function finish(detail) {
  if (activePrompt && detail && detail.prompt_id && detail.prompt_id !== activePrompt) return;
  activePrompt = null;
  release();
}

app.registerExtension({
  name: "H3.ClipPreview",
  setup() {
    api.addEventListener("executing", (e) => {
      const d = e.detail;
      executingNode = d && typeof d === "object" ? (d.display_node ?? d.node) : d;
    });
    api.addEventListener(EVENT, (e) => show(e.detail));
    // The clip belongs to the sampling stage; the real decode replaces it.
    for (const ev of ["execution_success", "execution_error", "execution_interrupted"]) {
      api.addEventListener(ev, (e) => finish(e.detail));
    }
  },
});
