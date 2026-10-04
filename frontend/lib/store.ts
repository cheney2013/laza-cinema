import { isMultiInputHandle } from './multiInput';
import { create } from 'zustand';
import { type Node, type Edge, applyNodeChanges, applyEdgeChanges, type NodeChange, type EdgeChange, type Connection, addEdge } from '@xyflow/react';

import { api, setActiveProjectId, setActiveSceneId } from './api';

// Prevent double-snapshot when node deletion cascades to connected-edge deletion in the same tick
let _lastSnapshotMs = 0;

export interface StudioSettings {
  autoplayOnComplete: boolean; // 视频生成完成后是否自动播放 (默认 true)
  unmuteOnComplete: boolean; // 生成完成后自动播放是否非静音 (默认 true)
  soundNotifyJobs: boolean; // 生成开始时语音播报预计耗时、结束时提示音 (默认 false)
}

const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
  autoplayOnComplete: true,
  unmuteOnComplete: true,
  soundNotifyJobs: false,
};

const getInitialStudioSettings = (): StudioSettings => {
  if (typeof window === 'undefined') return DEFAULT_STUDIO_SETTINGS;
  try {
    const raw = localStorage.getItem('ai_cinema_studio_settings');
    if (raw) {
      return { ...DEFAULT_STUDIO_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn('Failed to read studio settings from localStorage', e);
  }
  return DEFAULT_STUDIO_SETTINGS;
};

interface FlowState {
  nodes: Node[];
  edges: Edge[];
}

interface AppStore {
  backendOnline: boolean;
  setBackendOnline: (v: boolean) => void;

  comfyuiOnline: boolean;
  setComfyuiOnline: (v: boolean) => void;

  selectedModel: string;
  setSelectedModel: (m: string) => void;

  // Studio Settings (Persistent)
  settings: StudioSettings;
  updateSettings: (newSettings: Partial<StudioSettings>) => void;

  // Global Audio Exclusivity: only one video node may produce sound at a time
  activeAudioNodeId: string | null;
  setActiveAudioNodeId: (id: string | null) => void;

  // Project Management State
  currentProjectId: string | null;
  currentProjectName: string;
  setCurrentProject: (id: string | null, name: string) => void;
  /**
   * The scene of the current project on the canvas. Changing it is a request:
   * InfiniteCanvas saves the scene it has, loads this one, and only then are
   * `nodes` the new scene's. Opening another project starts at its first scene.
   */
  currentSceneId: string;
  setCurrentScene: (id: string) => void;
  /** Bumped when the scene list changes, so tabs and the overview re-read it. */
  scenesVersion: number;
  bumpScenes: () => void;

  // Flow State
  nodes: Node[];
  edges: Edge[];
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;

  // Undo/Redo
  past: FlowState[];
  future: FlowState[];
  undo: () => void;
  redo: () => void;
  takeSnapshot: () => void;
}


// The focus-mode classes (InfiniteCanvas displayNodes/displayEdges) are view
// state, but ReactFlow's 'replace'/'add' changes hand the displayed objects
// back, so they leaked into the store and from there into canvas.json: on
// 2026-09-05 a saved canvas had 51 nodes carrying node-dimmed, and clicking the
// blank pane never lit them again. Strip them on every change so the store, and
// what autosave writes, never carry them.
function stripFocusClasses<T>(items: T[], re: RegExp): T[] {
  let changed = false;
  const out = items.map((it) => {
    const cls = ((it as { className?: string }).className) || '';
    if (!re.test(cls)) { re.lastIndex = 0; return it; }
    re.lastIndex = 0;
    const clean = cls.replace(re, '').replace(/\s+/g, ' ').trim();
    changed = true;
    return { ...it, className: clean || undefined };
  });
  return changed ? out : items;
}

export const useStore = create<AppStore>((set, get) => ({

  backendOnline: false,
  setBackendOnline: (v) => set({ backendOnline: v }),

  comfyuiOnline: false,
  setComfyuiOnline: (v) => set({ comfyuiOnline: v }),

  selectedModel: 'flux2_dev_fp8mixed.safetensors',
  setSelectedModel: (m) => set({ selectedModel: m }),

  settings: getInitialStudioSettings(),
  updateSettings: (newSettings) => {
    set((state) => {
      const updated = { ...state.settings, ...newSettings };
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem('ai_cinema_studio_settings', JSON.stringify(updated));
        } catch (e) {}
      }
      return { settings: updated };
    });
  },

  activeAudioNodeId: null,
  setActiveAudioNodeId: (id) => set({ activeAudioNodeId: id }),

  currentProjectId: null,
  currentProjectName: '未命名项目',
  setCurrentProject: (id, name) => {
    // Everything the backend creates from here on is stamped with this project.
    setActiveProjectId(id);
    if (id !== get().currentProjectId) {
      setActiveSceneId('main');
      set({ currentSceneId: 'main' });
    }
    set({ currentProjectId: id, currentProjectName: name });
  },

  currentSceneId: 'main',
  setCurrentScene: (id) => set({ currentSceneId: id || 'main' }),
  scenesVersion: 0,
  bumpScenes: () => set((s) => ({ scenesVersion: s.scenesVersion + 1 })),

  nodes: [],
  edges: [],
  past: [],
  future: [],

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),

  onNodesChange: (changes) => {
    const removals = changes.filter((c) => c.type === 'remove') as { id: string; type: 'remove' }[];
    if (removals.length > 0) {
      const now = Date.now();
      if (now - _lastSnapshotMs > 100) { _lastSnapshotMs = now; get().takeSnapshot(); }

      // Automatically interrupt and cancel generation jobs for deleted nodes
      const currentNodes = get().nodes;
      removals.forEach((r) => {
        const targetNode = currentNodes.find((n) => n.id === r.id);
        const jobId = (targetNode?.data as any)?.jobId;
        if (jobId) {
          api.cancelJob(jobId).catch(() => {});
        }
      });

      // If the active audio node is being deleted, clear audio exclusivity
      const currentAudioId = get().activeAudioNodeId;
      if (currentAudioId && removals.some((r) => r.id === currentAudioId)) {
        get().setActiveAudioNodeId(null);
      }
    }
    set((state) => ({
      nodes: stripFocusClasses(applyNodeChanges(changes, state.nodes), /\bnode-(highlight-connected|dimmed)\b/g),
    }));
  },

  onEdgesChange: (changes) => {
    if (changes.some((c) => c.type === 'remove')) {
      const now = Date.now();
      if (now - _lastSnapshotMs > 100) { _lastSnapshotMs = now; get().takeSnapshot(); }
    }
    set((state) => ({
      edges: stripFocusClasses(applyEdgeChanges(changes, state.edges), /\bedge-(highlight-connected|dimmed)\b/g),
    }));
  },

  onConnect: (connection) => {
    // Re-drawing a wire that already exists changes nothing. It used to delete the
    // old edge and append a new one, which moved it to the end of the target's
    // inputs -- and input order is the <Picture N> numbering, so the prompt's
    // references were silently swapped (2026-09-23).
    const same = (value: string | null | undefined) => value ?? null;
    if (get().edges.some((e) =>
      e.source === connection.source && e.target === connection.target
      && same(e.sourceHandle) === same(connection.sourceHandle)
      && same(e.targetHandle) === same(connection.targetHandle))) return;
    get().takeSnapshot(); // snapshot BEFORE adding the edge
    set((state) => {
      const targetNode = state.nodes.find((n) => n.id === connection.target);

      // Determine whether this target handle allows multiple incoming connections:
      let isMultiInput = false;

      if (targetNode?.type === 'video') {
        // H3 视频节点：
        // in-image 为首帧参考图 -> 仅允许连接 1 个 (连入新线时替换旧线)
        // in-ref-image 为角色/道具参考图 -> 允许连接多个 (<图1>, <图2>...)
        // in-ref-audio, in-ref-video, in-prompt -> 允许连接多个
        // in-last-frame 引导帧 -> 允许多张，各钉一帧 (guideFrameIndexes 按连线顺序)
        if (
          connection.targetHandle === 'in-last-frame' ||
          connection.targetHandle === 'in-ref-image' ||
          connection.targetHandle === 'in-ref-audio' ||
          connection.targetHandle === 'in-ref-video' ||
          connection.targetHandle === 'in-prompt'
        ) {
          isMultiInput = true;
        } else {
          isMultiInput = false; // in-image 首帧图单进
        }
      } else if (['videoEdit', 'videoReshot', 'videoBridge', 'videoContinue', 'videoFrames'].includes(targetNode?.type as string)) {
        // H3 视频编辑节点：
        // in-first-frame, in-last-frame, in-video -> 单进
        // in-character, in-audio, in-prompt, in-guide-frame (引导帧，按连线顺序) -> 多进
        if (
          connection.targetHandle === 'in-guide-frame' ||
          connection.targetHandle === 'in-character' ||
          connection.targetHandle === 'in-audio' ||
          connection.targetHandle === 'in-prompt'
        ) {
          isMultiInput = true;
        } else {
          isMultiInput = false;
        }
      } else if (targetNode?.type === 'chainPreview') {
        // 智能视频预览：每根线是一路视频（普通视频或链尾），按节点里排的顺序连播
        isMultiInput = connection.targetHandle === 'in-video';
      } else {
        isMultiInput = isMultiInputHandle(targetNode?.type, connection.targetHandle);
      }

      const newEdge: Edge = {
        ...connection,
        id: `e-${connection.source}-${connection.sourceHandle ?? ''}-${connection.target}-${connection.targetHandle ?? ''}-${Date.now()}`,
        animated: false,
        style: { stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1.5 },
      };

      if (isMultiInput) {
        // Remove only exact duplicate (same source→target→handle), allow multiple sources on same handle
        const deduped = state.edges.filter(
          (e) => !(e.source === connection.source && e.target === connection.target && e.targetHandle === connection.targetHandle)
        );
        return { edges: [...deduped, newEdge] };
      }

      // Single-input ports: remove all existing edges to this target handle, then add
      const filtered = state.edges.filter(
        (e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle)
      );
      return { edges: [...filtered, newEdge] };
    });
  },

  takeSnapshot: () => {
    set((state) => {
      // Fast reference check: if neither array has changed identity, skip.
      const last = state.past[state.past.length - 1];
      if (last && last.nodes === state.nodes && last.edges === state.edges) {
        return state;
      }

      return {
        past: [...state.past.slice(-50), { nodes: state.nodes, edges: state.edges }],
        future: [],
      };
    });
  },

  undo: () => {
    set((state) => {
      if (state.past.length === 0) return state;

      const previous = state.past[state.past.length - 1];
      const remainingPast = state.past.slice(0, state.past.length - 1);

      return {
        past: remainingPast,
        future: [{ nodes: state.nodes, edges: state.edges }, ...state.future],
        nodes: previous.nodes,
        edges: previous.edges,
      };
    });
  },

  redo: () => {
    set((state) => {
      if (state.future.length === 0) return state;

      const next = state.future[0];
      const remainingFuture = state.future.slice(1);

      return {
        past: [...state.past, { nodes: state.nodes, edges: state.edges }],
        future: remainingFuture,
        nodes: next.nodes,
        edges: next.edges,
      };
    });
  },
}));
