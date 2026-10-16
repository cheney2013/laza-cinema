// Plays the clip written by ComfyUI-H3-LivePreview on a node.
//
// With an "H3 Live Preview" node in the workflow the clip is drawn on that node; it is refreshed every
// sampling step and keeps looping after the run. Without one it is drawn on the node that is sampling,
// for as long as it samples. When no node can be found, nothing is shown.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EVENT = "h3_live_preview";
const NODE_CLASS = "H3LivePreview";

let executingNode = null; // id of the node ComfyUI says it is running
let activePrompt = null;
let current = null; // the preview taking the clips of the run in progress

function makeVideo() {
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  return video;
}

// Ids of nodes inside subgraphs read "105:14": subgraph node 105, then node 14 inside it.
function resolveNode(id) {
  if (id == null) return null;
  let graph = app.graph;
  let node = null;
  for (const part of String(id).split(":")) {
    node = graph?.getNodeById?.(Number(part)) ?? graph?._nodes_by_id?.[part] ?? null;
    if (!node) return null;
    graph = node.subgraph ?? null;
  }
  return node;
}

function redraw(node) {
  node.graph?.setDirtyCanvas?.(true, false);
  app.canvas?.setDirty?.(true, false);
}

// A preview: a widget drawn on the node's own canvas (as the built-in image preview is), so it follows
// zoom and pan and never floats above other nodes, and the video that feeds it.
function buildPreview(node, persistent) {
  const video = makeVideo();
  const state = { step: 0, total: 0, running: false, hasClip: false };
  const preview = { node, video, state, persistent, raf: 0, url: null, token: 0, widget: null };
  preview.widget = {
    name: "h3_live_preview",
    type: "h3_live_preview",
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
      if (state.hasClip && video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(boxW / video.videoWidth, boxH / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        ctx.drawImage(video, pad + (boxW - w) / 2, y + (boxH - h) / 2, w, h);
      } else {
        ctx.fillStyle = "#777";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("preview appears while H3 samples", pad + boxW / 2, y + boxH / 2);
      }
      ctx.fillStyle = "#bbb";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(state.running ? "H3 live preview" : "last preview", pad, y + boxH + 2);
      if (state.total) {
        ctx.textAlign = "right";
        ctx.fillText(`step ${state.step}/${state.total}`, width - pad, y + boxH + 2);
      }
      ctx.restore();
    },
  };
  node.addCustomWidget ? node.addCustomWidget(preview.widget) : (node.widgets ||= []).push(preview.widget);
  const need = node.computeSize();
  if (node.size[1] < need[1]) node.setSize([node.size[0], need[1]]);
  return preview;
}

function startLoop(preview) {
  if (preview.raf) return;
  const tick = () => {
    // The node is gone (deleted, or its graph closed): stop drawing.
    if (!preview.node.graph) {
      preview.raf = 0;
      return;
    }
    redraw(preview.node);
    preview.raf = requestAnimationFrame(tick);
  };
  preview.raf = requestAnimationFrame(tick);
}

function dispose(preview) {
  cancelAnimationFrame(preview.raf);
  preview.raf = 0;
  preview.video.removeAttribute("src");
  preview.video.load();
  if (preview.url) URL.revokeObjectURL(preview.url);
  preview.url = null;
  const node = preview.node;
  const i = node.widgets ? node.widgets.indexOf(preview.widget) : -1;
  if (i >= 0) node.widgets.splice(i, 1);
  redraw(node);
}

// The preview for a node. The dedicated node keeps one for good; a sampler gets one for the run.
function previewFor(node, persistent) {
  if (persistent) {
    let preview = node.__h3live;
    if (!preview || !node.widgets?.includes(preview.widget)) {
      preview = buildPreview(node, true);
      node.__h3live = preview;
    }
    return preview;
  }
  return buildPreview(node, false);
}

async function load(preview, { filename, subfolder }) {
  const token = ++preview.token;
  const params = new URLSearchParams({ filename, subfolder: subfolder || "", type: "output" });
  let blob;
  try {
    const response = await api.fetchApi(`/view?${params}`, { cache: "no-store" });
    if (!response.ok) return;
    blob = await response.blob();
  } catch {
    return;
  }
  // A newer clip arrived while this one downloaded, or the preview was taken down.
  if (token !== preview.token || (!preview.persistent && current !== preview)) return;
  // The clip is held in memory: the file on disk is replaced by the next step and deleted later.
  const url = URL.createObjectURL(blob);
  const previous = preview.url;
  const t = preview.video.currentTime;
  preview.url = url;
  preview.video.src = url;
  preview.video.addEventListener("loadedmetadata", () => {
    // Keep the playhead where it was so a refreshed clip does not restart the loop.
    if (t && preview.video.duration) preview.video.currentTime = Math.min(t, preview.video.duration - 0.05);
    preview.video.play().catch(() => {});
    preview.state.hasClip = true;
    if (previous) URL.revokeObjectURL(previous);
  }, { once: true });
}

function show(detail) {
  const { prompt_id, step, total, node_id, exec_node } = detail;
  activePrompt = prompt_id;
  // The dedicated node when the workflow has one, else the node that is sampling. The sampler's own id
  // comes with the event; the front end's running-node tracking is the fallback.
  const running = exec_node ?? executingNode ?? app.runningNodeId ?? null;
  const named = resolveNode(node_id);
  const target = named || resolveNode(running);
  if (!target) {
    console.debug("[H3 Live Preview] no node to draw on for", { node_id, running });
    return;
  }
  const preview = previewFor(target, !!named);
  if (current && current !== preview) finish();
  current = preview;
  preview.state.running = true;
  preview.state.step = step;
  preview.state.total = total;
  startLoop(preview);
  load(preview, detail);
}

// The run is over. A dedicated node keeps looping its last clip; a sampler's temporary preview goes.
function finish(detail) {
  if (detail && detail.prompt_id && activePrompt && detail.prompt_id !== activePrompt) return;
  if (detail) activePrompt = null;
  const preview = current;
  current = null;
  if (!preview) return;
  preview.state.running = false;
  if (!preview.persistent) {
    preview.token++;
    dispose(preview);
  }
}

// An earlier version of the node had a pass-through output. A workflow saved with it keeps that slot
// when loaded, so it is removed here (nothing is connected to it: the node was never meant to have one).
function dropStaleOutputs(node) {
  while (node.outputs?.length) node.removeOutput(0);
}

app.registerExtension({
  name: "H3.LivePreview",
  nodeCreated(node) {
    // The dedicated node always carries its preview area, empty until a run fills it.
    if (node.comfyClass !== NODE_CLASS) return;
    previewFor(node, true);
  },
  loadedGraphNode(node) {
    if (node.comfyClass === NODE_CLASS) dropStaleOutputs(node);
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
