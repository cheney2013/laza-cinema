// Plays the clip written by ComfyUI-H3-ClipPreview.
//
// With an "H3 Clip Preview" node in the workflow, the clip is drawn on that node and its last frame
// stays there after the run. Without one, the clip is drawn on the node that is sampling for as long
// as it samples. If no node can be found, nothing is shown.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EVENT = "h3_clip_preview";
const WIDGET = "h3_clip_preview";

let executingNode = null; // id of the node ComfyUI says it is running
let activePrompt = null;
let host = null; // { node, widget, video, state, persistent, raf }

function makeVideo() {
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.style.cssText = "display:block;width:100%;background:#000";
  return video;
}

// Ids of nodes inside subgraphs read "105:14": subgraph node 105, then node 14 inside it.
function resolveNode(id) {
  if (id == null) return null;
  const parts = String(id).split(":");
  let graph = app.graph;
  let node = null;
  for (const part of parts) {
    node = graph?.getNodeById?.(Number(part)) ?? graph?._nodes_by_id?.[part] ?? null;
    if (!node) return null;
    graph = node.subgraph ?? null;
  }
  return node;
}

function removeWidget(node, widget) {
  const i = node.widgets ? node.widgets.indexOf(widget) : -1;
  if (i >= 0) node.widgets.splice(i, 1);
}

function redraw(node) {
  node.graph?.setDirtyCanvas?.(true, false);
  app.canvas?.setDirty?.(true, false);
}

function stopVideo(video) {
  video.removeAttribute("src");
  video.load();
}

// Ends the current preview. A dedicated node keeps the last frame; anything else is taken down.
function release({ keepLastFrame = false } = {}) {
  if (!host) return;
  const h = host;
  host = null;
  if (h.node) {
    cancelAnimationFrame(h.raf);
    if (h.persistent && keepLastFrame && h.video.videoWidth) {
      const snap = document.createElement("canvas");
      snap.width = h.video.videoWidth;
      snap.height = h.video.videoHeight;
      snap.getContext("2d").drawImage(h.video, 0, 0);
      h.state.snapshot = snap;
      h.state.live = false;
    } else {
      removeWidget(h.node, h.widget);
      if (h.sizeBefore) h.node.setSize([Math.max(h.node.size[0], h.sizeBefore[0]), h.sizeBefore[1]]);
    }
    stopVideo(h.video);
    redraw(h.node);
  }
}

// The preview area, drawn on the node's own canvas (as the built-in image preview is), so it follows
// zoom and pan and never floats above other nodes.
function buildWidget(persistent) {
  const video = makeVideo();
  const state = { step: 0, total: 0, live: !persistent, snapshot: null };
  const widget = {
    name: WIDGET,
    type: WIDGET,
    value: null,
    serialize: false,
    options: { serialize: false },
    computeSize: (width) => [width, 180],
    draw(ctx, n, widgetWidth, y) {
      // Never wider than the node itself, whatever width the layout reports.
      const width = Math.min(widgetWidth, n.size[0]);
      const pad = 8;
      const labelH = 14;
      const boxW = width - pad * 2;
      // The layout hands a custom widget one row of height; the picture takes the rest of the node.
      const boxH = Math.max(40, n.size[1] - y - pad - labelH);
      ctx.save();
      ctx.fillStyle = "#000";
      ctx.fillRect(pad, y, boxW, boxH);
      const src = state.live ? video : state.snapshot;
      const sw = state.live ? video.videoWidth : state.snapshot?.width;
      const sh = state.live ? video.videoHeight : state.snapshot?.height;
      if (src && sw && (!state.live || video.readyState >= 2)) {
        const scale = Math.min(boxW / sw, boxH / sh);
        ctx.drawImage(src, pad + (boxW - sw * scale) / 2, y + (boxH - sh * scale) / 2, sw * scale, sh * scale);
      } else if (persistent && !state.live) {
        ctx.fillStyle = "#777";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("preview appears while H3 samples", pad + boxW / 2, y + boxH / 2);
      }
      ctx.fillStyle = "#bbb";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(state.live ? "H3 clip preview" : "last preview", pad, y + boxH + 2);
      if (state.total) {
        ctx.textAlign = "right";
        ctx.fillText(`step ${state.step}/${state.total}`, width - pad, y + boxH + 2);
      }
      ctx.restore();
    },
  };
  return { widget, video, state };
}

function addWidget(node, widget) {
  node.addCustomWidget ? node.addCustomWidget(widget) : (node.widgets ||= []).push(widget);
  const need = node.computeSize();
  if (node.size[1] < need[1]) node.setSize([node.size[0], need[1]]);
}

function attachToNode(node, persistent) {
  let built = persistent ? node.__h3clip : null;
  const sizeBefore = [...node.size];
  if (!(built && node.widgets?.includes(built.widget))) {
    built = buildWidget(persistent);
    addWidget(node, built.widget);
    if (persistent) node.__h3clip = built;
  }
  const { widget, video, state } = built;
  state.live = true;
  host = { node, widget, video, state, persistent, sizeBefore, raf: 0 };
  const tick = () => {
    if (!host || host.widget !== widget) return;
    redraw(node);
    host.raf = requestAnimationFrame(tick);
  };
  host.raf = requestAnimationFrame(tick);
}

function show({ prompt_id, step, total, filename, subfolder, node_id, exec_node }) {
  if (activePrompt !== prompt_id) {
    release();
    activePrompt = prompt_id;
  }
  // The dedicated node when the workflow has one, else the node that is sampling.
  // The sampler's own id comes with the event; the front end's running-node tracking is the fallback.
  const running = exec_node ?? executingNode ?? app.runningNodeId ?? null;
  const named = resolveNode(node_id);
  const target = named || resolveNode(running);
  const dedicated = !!named;
  if (!target) {
    console.debug("[H3 Clip Preview] no node to draw on for", { node_id, running });
    release();
    return;
  }
  if (!host || host.node !== target) {
    release();
    attachToNode(target, dedicated);
  }
  const { video } = host;
  if (host.state) {
    host.state.step = step;
    host.state.total = total;
    host.state.live = true;
  }
  const params = new URLSearchParams({ filename, subfolder: subfolder || "", type: "output", t: String(Date.now()) });
  const t = video.currentTime;
  video.src = api.apiURL(`/view?${params}`);
  video.addEventListener("loadedmetadata", () => {
    // Keep the playhead where it was so a refreshed clip does not restart the loop.
    if (t && video.duration) video.currentTime = Math.min(t, video.duration - 0.05);
    video.play().catch(() => {});
  }, { once: true });
}

function finish(detail) {
  if (activePrompt && detail && detail.prompt_id && detail.prompt_id !== activePrompt) return;
  activePrompt = null;
  // The real decode replaces the clip; a dedicated node keeps the last frame to look at.
  release({ keepLastFrame: true });
}

app.registerExtension({
  name: "H3.ClipPreview",
  nodeCreated(node) {
    // The dedicated node always carries its preview area, empty until a run fills it.
    if (node.comfyClass !== "H3ClipPreview") return;
    const built = buildWidget(true);
    addWidget(node, built.widget);
    node.__h3clip = built;
  },
  setup() {
    api.addEventListener("executing", (e) => {
      const d = e.detail;
      executingNode = d && typeof d === "object" ? (d.display_node ?? d.node) : d;
    });
    // Newer front ends report the running node through progress_state as well.
    api.addEventListener("progress_state", (e) => {
      const nodes = e.detail?.nodes;
      if (!nodes) return;
      const running = Object.values(nodes).filter((n) => n?.state === "running");
      const last = running[running.length - 1];
      if (last) executingNode = last.display_node_id ?? last.node_id ?? executingNode;
    });
    api.addEventListener(EVENT, (e) => show(e.detail));
    for (const ev of ["execution_success", "execution_error", "execution_interrupted"]) {
      api.addEventListener(ev, (e) => finish(e.detail));
    }
  },
});
