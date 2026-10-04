'use client';

import { userScopedKey } from '@/lib/auth';
import { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type FinalConnectionState,
  ReactFlowProvider,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import PromptNode from './nodes/PromptNode';
import VideoGenNode from './nodes/VideoGenNode';
import CharacterSheetNode from './nodes/CharacterSheetNode';
import VideoEditNode, { VideoReshotNode, VideoBridgeNode, VideoContinueNode, VideoFramesNode } from './nodes/VideoEditNode';
import CharswapNode from './nodes/CharswapNode';
import ReangleNode from './nodes/ReangleNode';
import AudioRefineNode from './nodes/AudioRefineNode';
import VideoUpscaleNode from './nodes/VideoUpscaleNode';
import VideoInterpolateNode from './nodes/VideoInterpolateNode';
import VideoTrimNode from './nodes/VideoTrimNode';
import AudioGenNode from './nodes/AudioGenNode';
import VideoCompareNode from './nodes/VideoCompareNode';
import UploadNode from './nodes/UploadNode';
import InpaintNode from './nodes/InpaintNode';
import QwenImageNode from './nodes/QwenImageNode';
import ImageUpscaleNode from './nodes/ImageUpscaleNode';
import DepthVideoNode from './nodes/DepthVideoNode';
import WardrobeSwapNode from './nodes/WardrobeSwapNode';
import GaussianNode from './nodes/GaussianNode';
import GaussianViewerNode from './nodes/GaussianViewerNode';
import PoseNode from './nodes/PoseNode';
import PreviewImageNode from './nodes/PreviewImageNode';
import ChainPreviewNode from './nodes/ChainPreviewNode';
import GroupNode from './nodes/GroupNode';
import DeletableEdge from './edges/DeletableEdge';
import HeaderBar from './HeaderBar';
import BottomDock from './BottomDock';
import AssetLibrary from './AssetLibrary';
import CutRoom from './CutRoom/CutRoom';
import { useCutRoom } from '@/lib/editor/store';
import QuickNodePalette from './QuickNodePalette';
import { t, useT } from '@/lib/i18n';
import SelectionBoundingBox from './SelectionBoundingBox';
import PlayingNodeFloat from './PlayingNodeFloat';
import NodeSearch from './NodeSearch';
import ChainIndex from './ChainIndex';
import { api, setActiveSceneId, setShownCanvasRevision, shownCanvasRevision } from '@/lib/api';
import { cacheCanvas, safeSetItem } from '@/lib/canvasCache';
import { useStore } from '@/lib/store';
import { useAutoAlign } from '@/hooks/useAutoAlign';
import { useSingleAudioCoordinator } from '@/hooks/useSingleAudioCoordinator';
import HelperLines from './HelperLines';
import CanvasBackButton from './CanvasBackButton';
import { useCanvasNav } from '@/lib/canvasNav';
import TemporaryConnectionLine from './TemporaryConnectionLine';
import { DEFAULT_NODE_DIMENSIONS } from '@/lib/types';
import { constrainResizeChanges } from '@/lib/nodeSizing';
import {
  collapsedMemberIds,
  createGroupNode,
  groupsFirst,
  isGroupNode,
  reconcileGroups,
  withGroupMemberMoves,
} from '@/lib/canvasGroups';
import { BACKEND_URL as API_BASE, posterUrl } from '@/lib/config';
import {
  NODE_DEFINITIONS,
  CREATABLE_NODE_DEFINITIONS,
  getCompatibleNodesForPort,
  getExistingCompatibleNodesOnCanvas,
  type ExistingCompatibleNode,
  validateConnectionSchema,
} from '@/lib/nodeRegistry';
import { migrateAssetSourceHandles, migrateGaussianSourceHandles,
  migrateAbsoluteAssetUrls, migrateDirectorPromptSource, migrateImageComfyFilename,
         migrateNodeSizes, migrateEditModeNodes, EDIT_FAMILY,
         migrateRemovedImageNodes, migrateRetiredGenerators } from '@/lib/migrations';
import { showAlert, showConfirm } from '@/components/ui/Dialog';
import SceneBar from './SceneBar';
import { NATIVE_VIDEO_CHROME_OFF } from '@/components/nodes/mediaChrome';

// Props handed to <ReactFlow> must keep their identity across renders: GraphView,
// NodeRenderer and EdgeRenderer are memo'd on them, and InfiniteCanvas re-renders on
// every drag frame (it subscribes to `nodes`). Inline arrows and object literals
// here re-rendered all ~105 NodeWrappers and EdgeWrappers per frame (measured
// 2026-09-16 on a 105-node canvas: 90-105 wrapper renders per drag).
const DELETE_KEYS = ['Backspace', 'Delete'];
const NO_DELETE_KEYS: string[] = [];
const FLOW_STYLE = { background: '#08080a' } as const;

/** Where the scene a project was last left on is remembered, per project. */
const lastSceneKey = (projectId: string) => `ai_cinema_last_scene_${projectId}`;
// Keep this selector to a handful of elements: every one it matches is restyled
// on every zoom frame (298 ports cost ~15 ms/frame on a large scene).
const zoomRule = (zoom: number) => `.node-alias-tag,.node-bible-tab,.canvas-lod .edge-delete-btn,.canvas-lod .lod-audio-name{--rf-zoom:${zoom}}`;
// Edge width tier for the zoom. Under ~1 screen px a line shimmers while the
// canvas pans (anti-aliasing lands it on a different sub-pixel each frame) --
// the flicker seen at 0.33 on 2026-09-23. Each tier keeps the line ~1.1-1.9
// px on screen; the tier flips only when a boundary is crossed (data attribute
// on the wrapper, rules in globals.css), never per frame.
const edgeTier = (zoom: number) => (zoom >= 0.6 ? 0 : zoom >= 0.35 ? 1 : zoom >= 0.2 ? 2 : zoom >= 0.12 ? 3 : 4);
/** Below this zoom nodes are drawn as outlines: select, drag, wire and pan only. */
const LOD_ZOOM = 0.35;

/**
 * A canvas as it comes off the backend, made ready for the studio: a node left
 * "generating" with no job to follow is idle, and every stored-format migration
 * runs. The same steps for opening a project and for switching scenes.
 */
function prepareLoadedCanvas(rawNodes: Node[], rawEdges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const sanitized = (rawNodes || []).map((n: Node) => {
    if ((n.data as any)?.status === 'generating' && !(n.data as any)?.jobId) {
      return { ...n, data: { ...n.data, status: 'idle' } };
    }
    return n;
  });
  const removed = migrateRemovedImageNodes(sanitized, rawEdges || []);
  const moved = migrateRetiredGenerators(removed.nodes, removed.edges);
  const migrated = { nodes: migrateEditModeNodes(moved.nodes, moved.edges).nodes, edges: moved.edges };
  return {
    nodes: migrateImageComfyFilename(migrateAbsoluteAssetUrls(migrateNodeSizes(
      migrateDirectorPromptSource(migrated.nodes).nodes).nodes).nodes).nodes,
    edges: migrateGaussianSourceHandles(migrated.nodes,
      migrateAssetSourceHandles(migrated.nodes, migrated.edges).edges).edges,
  };
}
const DEFAULT_EDGE_OPTIONS = {
  style: { stroke: 'rgba(255,255,255,0.25)', strokeWidth: 1.8 },
  animated: false,
};

const nodeTypes = {
  prompt: PromptNode,
  video: VideoGenNode,
  videoEdit: VideoEditNode,
  videoReshot: VideoReshotNode,
  videoBridge: VideoBridgeNode,
  videoContinue: VideoContinueNode,
  videoFrames: VideoFramesNode,
  charswap: CharswapNode,
  videoReangle: ReangleNode,
  audioRefine: AudioRefineNode,
  videoUpscale: VideoUpscaleNode,
  videoInterpolate: VideoInterpolateNode,
  videoTrim: VideoTrimNode,
  depthVideo: DepthVideoNode,
  audioGen: AudioGenNode,
  videoCompare: VideoCompareNode,
  image: UploadNode,

  inpaint: InpaintNode,
  qwenImage: QwenImageNode,
  imageUpscale: ImageUpscaleNode,
  wardrobeSwap: WardrobeSwapNode,
  characterSheet: CharacterSheetNode,
  gaussian: GaussianNode,
  gaussianViewer: GaussianViewerNode,
  pose: PoseNode,
  preview: PreviewImageNode,
  chainPreview: ChainPreviewNode,
  group: GroupNode,
};

const edgeTypes = {
  default: DeletableEdge,
};

function Canvas() {
  const t = useT();
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const onStoreNodesChange = useStore((s) => s.onNodesChange);
  const onEdgesChange = useStore((s) => s.onEdgesChange);
  const onStoreConnect = useStore((s) => s.onConnect);
  const setNodes = useStore((s) => s.setNodes);
  const setEdges = useStore((s) => s.setEdges);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const takeSnapshot = useStore((s) => s.takeSnapshot);
  const setBackendOnline = useStore((s) => s.setBackendOnline);
  const setComfyuiOnline = useStore((s) => s.setComfyuiOnline);
  const selectedModel = useStore((s) => s.selectedModel);
  const { screenToFlowPosition, getNode, getViewport, setViewport, fitView, setCenter, setNodes: setReactFlowNodes } = useReactFlow();
  const { alignNodes } = useAutoAlign();
  useSingleAudioCoordinator();

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // 有媒体的节点在拖拽过程中就锁死媒体比例。NodeResizer 的 keepAspectRatio
    // 做不到这件事（它锁的是含固定像素功能区的节点框比例），只能在这里按方程
    // 改写它每帧派发出来的 dimensions。详见 lib/nodeSizing.ts。
    const constrained = constrainResizeChanges(changes as any, (nodeId) =>
      getNode(nodeId) as any,
    ) as NodeChange[];

    // A group drag carries what sits inside it. This has to happen before
    // alignNodes, or the members snap to guides individually and the frame
    // arrives somewhere its contents did not.
    const currentNodes = useStore.getState().nodes;
    const withMembers = withGroupMemberMoves(constrained, currentNodes);

    const hasDragPosition = withMembers.some(
      (c): c is any => c.type === 'position' && c.dragging !== undefined && !!c.position
    );
    if (hasDragPosition) {
      const { zoom } = getViewport();
      const alignedChanges = alignNodes(withMembers, currentNodes, zoom);
      onStoreNodesChange(alignedChanges);
    } else {
      onStoreNodesChange(withMembers);
    }

    // Collapsing is written as one boolean, by this studio or by the canvas MCP;
    // reconcileGroups is what turns it into a recorded member list and a folded
    // frame. Cheap and a no-op on a canvas with no groups.
    const settled = reconcileGroups(useStore.getState().nodes);
    if (settled !== useStore.getState().nodes) setNodes(settled);
  }, [alignNodes, onStoreNodesChange, getViewport, getNode, setNodes]);

  /** Frame the current selection, or drop an empty frame at `at`. */
  const createGroup = useCallback((at?: { x: number; y: number }) => {
    const all = useStore.getState().nodes;
    const chosen = all.filter((n) => n.selected && !isGroupNode(n));
    if (chosen.length === 0 && !at) return;
    takeSnapshot();
    const group = chosen.length > 0
      ? createGroupNode(chosen)
      : { ...createGroupNode([]), position: at! };
    // Prepended so it paints behind everything that already exists; groupsFirst
    // keeps it there once more groups appear.
    setNodes([group, ...all.map((n) => (n.selected ? { ...n, selected: false } : n))]);
  }, [setNodes, takeSnapshot]);

  const currentProjectId = useStore((s) => s.currentProjectId);
  const setCurrentProject = useStore((s) => s.setCurrentProject);

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, cx: number, cy: number } | null>(null);
  // Right-click on a node. The browser's own menu is suppressed across the
  // canvas so this one can take its place.
  const [nodeMenu, setNodeMenu] = useState<{ x: number, y: number, nodeId: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [contextSearch, setContextSearch] = useState('');
  const [portMenu, setPortMenu] = useState<{ x: number, y: number, cx: number, cy: number, portType: string, nodeId: string, handleType: 'source' | 'target', handleId: string | null } | null>(null);
  const [portSearch, setPortSearch] = useState('');
  const lastClickTime = useRef(0);
  const justSetPortMenu = useRef(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [initViewport, setInitViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [shouldFitView, setShouldFitView] = useState(false);
  const [hasInputFocus, setHasInputFocus] = useState(false);
  const canvasRevisionRef = useRef(0);
  /** The revision on screen; api.saveCanvas callers that do not pass one use it too. */
  const setCanvasRevision = useCallback((projectId: string, scene: string, revision: number) => {
    canvasRevisionRef.current = revision;
    setShownCanvasRevision(projectId, scene, revision);
  }, []);
  const skipNextAutoSaveRef = useRef(false);
  // An agent writing the canvas over the MCP takes a project lock (backend
  // /projects/{id}/lock). While it is held the studio must not auto-save: a save
  // from here would either 409 the agent's write or, worse, land after it and
  // silently overwrite a node the agent just filled in.
  const agentLockRef = useRef<{ agent: string; until: number; reason?: string } | null>(null);
  // Which project and scene the nodes in memory belong to. The store's
  // currentSceneId is what was asked for; these are what is actually loaded, and
  // every save and poll goes to them. Auto-save and polling stand still while a
  // switch is under way, so one scene's nodes can never be written into another.
  const canvasSceneRef = useRef('main');
  const canvasProjectRef = useRef<string | null>(null);
  const switchingSceneRef = useRef(false);
  const currentSceneId = useStore((s) => s.currentSceneId);
  const [agentLock, setAgentLock] = useState<{ agent: string; until: number; reason?: string } | null>(null);

  const isInputLikeFocused = useCallback(() => {
    const activeEl = document.activeElement;
    if (!activeEl) return false;
    const tag = activeEl.tagName?.toLowerCase();
    return (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      (activeEl as HTMLElement).isContentEditable
    );
  }, []);

  useEffect(() => {
    const handleWheelCapture = (event: WheelEvent) => {
      if (!(hasInputFocus || isInputLikeFocused())) return;
      const target = event.target as HTMLElement | null;
      const scrollable = target?.closest?.(
        'textarea, .nowheel, [data-scrollable]'
      );
      // 滚轮落在真能滚的东西上：交给它自己滚，只挡住画布缩放。
      // stopPropagation 就够了（d3-zoom 的监听挂在 pane 上，window 捕获阶段先跑）；
      // 这里绝不能 preventDefault —— 那会连带干掉它自身的原生滚动，滚轮就彻底失灵了。
      if (scrollable) {
        event.stopPropagation();
        return;
      }
      // 单行输入框没有可滚的内容，却因为"聚焦即吞掉滚轮"让整张画布不能缩放 ——
      // 填个种子数再滚滚轮，画布是死的。所以这里放行给 d3-zoom。
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName?.toLowerCase();
      const singleLine = tag === 'input' || tag === 'select';
      if (singleLine) {
        // 例外只有一个：光标正压在这个聚焦的 number/select 上时，浏览器会拿滚轮改它的值。
        // preventDefault 只掐掉那次改值，d3-zoom 自己也 preventDefault，缩放照常。
        if (active === target) event.preventDefault();
        return;
      }
      event.stopPropagation();
      event.preventDefault();
    };

    window.addEventListener('wheel', handleWheelCapture, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', handleWheelCapture, true);
  }, [hasInputFocus, isInputLikeFocused]);

  // Cinema Studio Modals State
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isCutRoomOpen, setIsCutRoomOpen] = useState(false);
  /** The cut room was opened from the library; closing it goes back there. */
  const [returnToLibrary, setReturnToLibrary] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteCoords, setPaletteCoords] = useState<{ x: number; y: number } | null>(null);

  // Load project & canvas on mount
  useEffect(() => {
    let active = true;

    async function initCanvas() {
      try {
        const lastSavedProjId = localStorage.getItem(userScopedKey('ai_cinema_last_project_id'));
        let projList: any[] = [];
        try {
          const res = await api.listProjects();
          projList = res.projects || [];
        } catch (e) {
          console.warn('Backend offline or error fetching projects, falling back to local', e);
        }

        let targetProject: any = null;

        if (projList.length > 0) {
          if (lastSavedProjId) {
            targetProject = projList.find((p) => p.id === lastSavedProjId);
          }
          if (!targetProject) {
            targetProject = projList[0];
          }
        } else {
          // If project list is empty, create default project
          try {
            targetProject = await api.createProject(t('默认项目'));
          } catch (e) {
            console.warn('Could not create default project on backend', e);
          }
        }

        if (targetProject && active) {
          setCurrentProject(targetProject.id, targetProject.name);
          localStorage.setItem(userScopedKey('ai_cinema_last_project_id'), targetProject.id);

          // Reopen the scene this project was last left on, if it still exists.
          let scene = 'main';
          try {
            const remembered = localStorage.getItem(lastSceneKey(targetProject.id));
            if (remembered && remembered !== 'main') {
              const { scenes } = await api.listScenes(targetProject.id);
              if (scenes.some((s) => s.id === remembered)) scene = remembered;
            }
          } catch {
            scene = 'main';
          }

          // Try loading project canvas from backend
          try {
            const canvasData = await api.loadCanvas(targetProject.id, 'default', scene);
            if (active && canvasData && Array.isArray(canvasData.nodes)) {
              setCanvasRevision(targetProject.id, scene, canvasData.revision ?? 0);
              canvasProjectRef.current = targetProject.id;
              canvasSceneRef.current = scene;
              setActiveSceneId(scene);
              useStore.getState().setCurrentScene(scene);
              const prepared = prepareLoadedCanvas(canvasData.nodes as Node[], canvasData.edges as Edge[]);
              setNodes(prepared.nodes);
              setEdges(prepared.edges);
              if (canvasData.viewport && typeof (canvasData.viewport as any).zoom === 'number') {
                setInitViewport(canvasData.viewport as any);
              } else if (prepared.nodes.length > 0) {
                setShouldFitView(true);
              }
              setIsLoaded(true);
              return;
            }
          } catch (e) {
            console.warn('Failed to load canvas from backend, falling back to localStorage', e);
          }
        }

        // Fallback: LocalStorage
        const savedNodes = localStorage.getItem(userScopedKey('cinima-nodes'));
        const savedEdges = localStorage.getItem(userScopedKey('cinima-edges'));
        const savedViewport = localStorage.getItem(userScopedKey('cinima-viewport'));

        let hasSavedNodes = false;
        if (savedNodes && active) {
          const parsedNodes = JSON.parse(savedNodes);
          const sanitized = parsedNodes.map((n: Node) => {
            if ((n.data as any)?.status === 'generating' && !(n.data as any)?.jobId) {
              return { ...n, data: { ...n.data, status: 'idle' } };
            }
            return n;
          });
          const removed = migrateRemovedImageNodes(sanitized, savedEdges ? JSON.parse(savedEdges) : []);
          const moved = migrateRetiredGenerators(removed.nodes, removed.edges);
          const migrated = { nodes: migrateEditModeNodes(moved.nodes, moved.edges).nodes, edges: moved.edges };
          setNodes(migrateAbsoluteAssetUrls(migrateNodeSizes(migrateDirectorPromptSource(
            migrated.nodes).nodes).nodes).nodes);
          setEdges(migrateGaussianSourceHandles(migrated.nodes,
            migrateAssetSourceHandles(migrated.nodes, migrated.edges).edges).edges);
          hasSavedNodes = migrated.nodes.length > 0;
        }

        if (savedViewport && active) {
          setInitViewport(JSON.parse(savedViewport));
        } else if (hasSavedNodes && active) {
          setShouldFitView(true);
        }
      } catch (e) {
        console.error('Failed to initialize canvas', e);
      } finally {
        if (active) setIsLoaded(true);
      }
    }

    initCanvas();

    return () => {
      active = false;
    };
  }, [setNodes, setEdges, setCurrentProject]);

  // Save to backend project canvas + localStorage fallback when changed
  useEffect(() => {
    if (!isLoaded) return;
    const timer = setTimeout(() => {
      if (switchingSceneRef.current) return;
      if (skipNextAutoSaveRef.current) {
        skipNextAutoSaveRef.current = false;
        return;
      }
      const scene = canvasSceneRef.current;
      // 1. Offline fallback in localStorage: only for a canvas small enough to fit; a big one is not
      //    cached (the backend holds it) instead of failing on every save.
      cacheCanvas(localStorage, userScopedKey('cinima-nodes'), userScopedKey('cinima-edges'), nodes, edges);

      // 2. Save to backend project canvas -- unless an agent holds the lock
      const projId = useStore.getState().currentProjectId;
      const lock = agentLockRef.current;
      if (lock && lock.until * 1000 > Date.now()) {
        return; // the change stays dirty; the next edit or poll retries
      }
      if (projId) {
        try {
          const vp = getViewport();
          api.saveCanvas(projId, {
            nodes,
            edges,
            viewport: vp,
            base_revision: canvasRevisionRef.current,
          }, 'default', scene).then((saved) => {
            if (canvasSceneRef.current === scene) setCanvasRevision(projId, scene, saved.revision);
          }).catch(async (err) => {
            console.warn('Backend canvas auto-save error:', err);
            if ((err as any)?.status === 423) {
              // Locked by an agent between our poll and our save. Keep our edits
              // in memory; the poll below will show the lock and pick up the
              // agent's version when it releases.
              return;
            }
            if ((err as any)?.status === 409) {
              if (switchingSceneRef.current || canvasSceneRef.current !== scene) return;
              try {
                const remote = await api.loadCanvas(projId, 'default', scene);
                if (switchingSceneRef.current || canvasSceneRef.current !== scene) return;
                setCanvasRevision(projId, scene, remote.revision ?? canvasRevisionRef.current);
                skipNextAutoSaveRef.current = true;
                setNodes(remote.nodes as Node[]);
                setEdges(remote.edges as Edge[]);
              } catch (reloadError) {
                console.warn('Failed to reload externally changed canvas:', reloadError);
              }
            }
          });
        } catch (err) {
          console.warn('Backend save canvas exception:', err);
        }
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [nodes, edges, isLoaded, getViewport]);

  // MCP and other external editors update the same versioned canvas. Pull those
  // changes into an already-open studio without requiring a page refresh.
  useEffect(() => {
    if (!isLoaded || !currentProjectId) return;
    let active = true;
    const syncExternalCanvas = async () => {
      if (switchingSceneRef.current) return;
      const scene = canvasSceneRef.current;
      try {
        // Only the revision and the lock unless something changed: the full canvas
        // is megabytes (4 MB for a large scene) and this runs every 3 s.
        const remote = await api.loadCanvas(currentProjectId, 'default', scene, canvasRevisionRef.current);
        if (switchingSceneRef.current || canvasSceneRef.current !== scene) return;
        const remoteLock = ((remote as any).lock ?? null) as { agent: string; until: number; reason?: string } | null;
        const liveLock = remoteLock && remoteLock.until * 1000 > Date.now() ? remoteLock : null;
        if (active && (liveLock?.agent !== agentLockRef.current?.agent || liveLock?.until !== agentLockRef.current?.until)) {
          agentLockRef.current = liveLock;
          setAgentLock(liveLock);
        }
        const remoteRevision = remote.revision ?? 0;
        if (active && remoteRevision > canvasRevisionRef.current) {
          setCanvasRevision(currentProjectId, scene, remoteRevision);
          skipNextAutoSaveRef.current = true;
          setNodes(remote.nodes as Node[]);
          setEdges(remote.edges as Edge[]);
        }
      } catch {
        // Backend availability is reported by the health check; polling stays quiet.
      }
    };
    const timer = window.setInterval(syncExternalCanvas, 3000);
    // A background tab's timers are throttled and a sleeping laptop's stop, so a
    // tab coming back is checked at once rather than on the next tick.
    const onVisible = () => { if (document.visibilityState === 'visible') void syncExternalCanvas(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [currentProjectId, isLoaded, setNodes, setEdges]);

  // Another project was opened (ProjectStudioModal loads its canvas itself): the
  // nodes in memory are now that project's first scene.
  useEffect(() => {
    if (!isLoaded || !currentProjectId) return;
    if (canvasProjectRef.current !== currentProjectId) {
      canvasProjectRef.current = currentProjectId;
      canvasSceneRef.current = 'main';
      setActiveSceneId('main');
      // The revision the opener loaded; unknown means 0, which the next save
      // turns into a 409 and a reload rather than an overwrite.
      canvasRevisionRef.current = shownCanvasRevision(currentProjectId, 'main') ?? 0;
    }
  }, [currentProjectId, isLoaded]);

  // A scene tab was chosen: save the scene on screen, then load the new one.
  useEffect(() => {
    if (!isLoaded || !currentProjectId) return;
    const target = currentSceneId || 'main';
    const from = canvasSceneRef.current;
    if (target === from || switchingSceneRef.current) return;
    const projectId = currentProjectId;
    switchingSceneRef.current = true;
    (async () => {
      const store = useStore.getState();
      // 1. The scene being left keeps its edits. An agent holding its lock has
      //    the canvas; anything else that fails asks before those edits are dropped.
      const lock = agentLockRef.current;
      if (!(lock && lock.until * 1000 > Date.now())) {
        try {
          await api.saveCanvas(projectId, {
            nodes: store.nodes, edges: store.edges, viewport: getViewport(),
            base_revision: canvasRevisionRef.current,
          }, 'default', from);
        } catch (err: any) {
          // 404: the scene was just removed (e.g. from the overview) — nothing to keep.
          const leave = err?.status === 404 || await showConfirm(
            t('当前场景的改动没能保存（{error}）。仍然切换场景并放弃这些改动吗？', { error: err?.message || err }),
            { title: t('切换场景'), confirmText: t('放弃改动并切换'), danger: true },
          );
          if (!leave) {
            switchingSceneRef.current = false;
            store.setCurrentScene(from);
            return;
          }
        }
      }
      // 2. The new scene, through the same preparation as opening a project.
      try {
        const canvasData = await api.loadCanvas(projectId, 'default', target);
        const prepared = prepareLoadedCanvas(canvasData.nodes as Node[], canvasData.edges as Edge[]);
        canvasSceneRef.current = target;
        setActiveSceneId(target);
        setCanvasRevision(projectId, target, canvasData.revision ?? 0);
        skipNextAutoSaveRef.current = true;
        // Undo belongs to one canvas: stepping back must not bring another scene's nodes here.
        useStore.setState({ nodes: prepared.nodes, edges: prepared.edges, past: [], future: [] });
        const lockData = ((canvasData as any).lock ?? null) as typeof agentLockRef.current;
        agentLockRef.current = lockData;
        setAgentLock(lockData);
        localStorage.setItem(lastSceneKey(projectId), target);
        const vp = canvasData.viewport as { x: number; y: number; zoom: number } | undefined;
        requestAnimationFrame(() => {
          if (vp && typeof vp.zoom === 'number') setViewport(vp);
          else if (prepared.nodes.length > 0) fitView({ padding: 0.2 });
        });
      } catch (err: any) {
        store.setCurrentScene(from);
        void showAlert(t('打开场景失败：{error}', { error: err?.message || err }), { title: t('切换场景'), danger: true });
      } finally {
        switchingSceneRef.current = false;
      }
    })();
  }, [currentSceneId, currentProjectId, isLoaded, getViewport, setViewport, fitView]);

  useEffect(() => {
    const check = async () => {
      try {
        const h = await api.health();
        setBackendOnline(true);
        setComfyuiOnline(h.comfyui);
      } catch {
        setBackendOnline(false);
        setComfyuiOnline(false);
      }
    };
    check();
    const timer = setInterval(check, 8_000);
    return () => clearInterval(timer);
  }, [setBackendOnline, setComfyuiOnline]);

  useEffect(() => {
    const handleOpenPortMenu = (e: any) => {
      const position = screenToFlowPosition({ x: e.detail.clientX, y: e.detail.clientY });
      setPortMenu({
        x: e.detail.clientX,
        y: e.detail.clientY,
        cx: position.x,
        cy: position.y,
        portType: e.detail.portType,
        nodeId: e.detail.nodeId,
        handleType: e.detail.handleType,
        handleId: e.detail.handleId,
      });
      setPortSearch('');
      setContextMenu(null);
    };
    window.addEventListener('openPortMenu', handleOpenPortMenu);
    return () => window.removeEventListener('openPortMenu', handleOpenPortMenu);
  }, [screenToFlowPosition]);

  useEffect(() => {
    const handleInputFocused = () => setHasInputFocus(true);
    const handleInputBlurred = () => setHasInputFocus(false);

    const handleToggleLibrary = () => setIsLibraryOpen((prev) => !prev);
    const handleEditAsset = (e: Event) => {
      const asset = (e as CustomEvent<{ name: string; url: string; kind?: 'video' | 'audio' | 'image' }>).detail;
      if (!asset) return;
      // Editing one clip is a detour from browsing, so remember to come back:
      // the library reopens where it was when the cut room closes.
      setReturnToLibrary(true);
      void useCutRoom.getState().openScratch(asset);
      setIsCutRoomOpen(true);
    };
    const handleToggleCutRoom = () => setIsCutRoomOpen((prev) => !prev);
    // 定位到时间线上的某个片段：只负责把剪辑台打开，选中和播放头由剪辑台在
    // 载入结束后消费 focusClipId 完成 —— 打开可能触发一次载入，而载入会清空选择。
    const handleFocusClip = (e: Event) => {
      const detail = (e as CustomEvent<{ clipId?: string; seqId?: string }>).detail;
      if (!detail?.clipId) return;
      useCutRoom.getState().requestFocusClip(detail.clipId, detail.seqId);
      setIsCutRoomOpen(true);
    };
    const handleOpenPalette = (e: any) => {
      if (e.detail?.x && e.detail?.y) {
        const flowPos = screenToFlowPosition({ x: e.detail.x, y: e.detail.y });
        setPaletteCoords(flowPos);
      } else {
        setPaletteCoords(null);
      }
      setIsPaletteOpen(true);
    };

    window.addEventListener('inputFocused', handleInputFocused);
    window.addEventListener('inputBlurred', handleInputBlurred);
    window.addEventListener('toggleAssetLibrary', handleToggleLibrary);
    window.addEventListener('openCutRoomWithAsset', handleEditAsset);
    window.addEventListener('toggleCutRoom', handleToggleCutRoom);
    window.addEventListener('openCutRoomAtClip', handleFocusClip);
    window.addEventListener('openQuickPalette', handleOpenPalette);

    return () => {
      window.removeEventListener('inputFocused', handleInputFocused);
      window.removeEventListener('inputBlurred', handleInputBlurred);
      window.removeEventListener('toggleAssetLibrary', handleToggleLibrary);
      window.removeEventListener('openCutRoomWithAsset', handleEditAsset);
      window.removeEventListener('toggleCutRoom', handleToggleCutRoom);
      window.removeEventListener('openCutRoomAtClip', handleFocusClip);
      window.removeEventListener('openQuickPalette', handleOpenPalette);
    };
  }, [screenToFlowPosition]);

  useEffect(() => {
    const handleTakeSnapshot = () => takeSnapshot();
    window.addEventListener('takeSnapshot', handleTakeSnapshot);
    return () => window.removeEventListener('takeSnapshot', handleTakeSnapshot);
  }, [takeSnapshot]);

  // Copy/Paste functionality
  const copyBufferRef = useRef<{ nodes: Node[], edges: Edge[] } | null>(null);

  const copyNodes = useCallback(() => {
    const selectedNodes = nodes
      .filter(node => node.selected)
      .map(node => ({
        ...node,
        position: { ...node.position },
        data: { ...node.data }
      }));
    
    if (selectedNodes.length === 0) return;

    // Edges are captured by what they connect, not by edge.selected -- selecting
    // nodes does not select the edges between them, so relying on the flag lost
    // every wire. Two kinds are kept: internal edges (both ends copied) get
    // remapped onto the new nodes, and incoming edges from nodes outside the
    // selection get re-pointed at the copy, so a pasted node arrives already fed
    // by the same upstream nodes as the original.
    const selectedIds = new Set(selectedNodes.map(node => node.id));
    const selectedEdges = edges
      .filter(edge => selectedIds.has(edge.target))
      .map(edge => ({ ...edge }));

    copyBufferRef.current = {
      nodes: selectedNodes,
      edges: selectedEdges
    };
  }, [nodes, edges]);

  const pasteNodes = useCallback(() => {
    if (!copyBufferRef.current || copyBufferRef.current.nodes.length === 0) return;

    takeSnapshot();

    const offset = 40;
    const newNodes: Node[] = [];
    const newNodeIdMap = new Map<string, string>();

    const deselectedNodes = nodes.map(node => ({ ...node, selected: false }));
    const deselectedEdges = edges.map(edge => ({ ...edge, selected: false }));

    copyBufferRef.current.nodes.forEach((node, idx) => {
      const newId = `${node.type}-${Date.now()}-${idx}`;
      newNodeIdMap.set(node.id, newId);

      const data = { ...node.data };
      if ((data as any).jobId) delete (data as any).jobId;
      if ((data as any).status === 'generating') (data as any).status = 'idle';

      newNodes.push({
        ...node,
        id: newId,
        position: {
          x: node.position.x + offset,
          y: node.position.y + offset
        },
        data,
        selected: true
      });

      node.position.x += offset;
      node.position.y += offset;
    });

    const liveNodeIds = new Set(nodes.map(node => node.id));

    const newEdges: Edge[] = copyBufferRef.current.edges.map(edge => {
      const newTargetId = newNodeIdMap.get(edge.target);
      if (!newTargetId) return null;

      // An external source keeps its own id, so the copy hangs off the same
      // upstream node; it may have been deleted since the copy, so check it is
      // still on the canvas.
      const newSourceId = newNodeIdMap.get(edge.source) ?? edge.source;
      if (!newNodeIdMap.has(edge.source) && !liveNodeIds.has(edge.source)) return null;

      return {
        ...edge,
        id: `e-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        source: newSourceId,
        target: newTargetId,
        selected: true
      };
    }).filter(Boolean) as Edge[];

    setNodes([...deselectedNodes, ...newNodes]);
    setEdges([...deselectedEdges, ...newEdges]);
  }, [nodes, edges, setNodes, setEdges, takeSnapshot]);

  const selectAllNodes = useCallback(() => {
    const currentNodes = useStore.getState().nodes;
    const currentEdges = useStore.getState().edges;
    if (currentNodes.length === 0) return;

    setNodes(currentNodes.map((node) => ({ ...node, selected: true })));
    setEdges(currentEdges.map((edge) => ({ ...edge, selected: true })));
    setReactFlowNodes((nds) => nds.map((node) => ({ ...node, selected: true })));
  }, [setNodes, setEdges, setReactFlowNodes]);

  const copyNodesRef = useRef(copyNodes);
  const pasteNodesRef = useRef(pasteNodes);
  const selectAllNodesRef = useRef(selectAllNodes);
  useEffect(() => {
    copyNodesRef.current = copyNodes;
    pasteNodesRef.current = pasteNodes;
    selectAllNodesRef.current = selectAllNodes;
  }, [copyNodes, pasteNodes, selectAllNodes]);

  // Keyboard shortcuts
  useEffect(() => {
    const isInputActive = () => {
      const activeEl = document.activeElement;
      if (!activeEl) return false;
      const tag = activeEl.tagName?.toLowerCase();
      return (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (activeEl as HTMLElement).isContentEditable
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // The cut room is a full-screen mode with its own bindings for these very
      // keys. Without this, Space opens the node palette on top of the editor
      // and Ctrl+Z undoes a canvas edit instead of the cut.
      if (useCutRoom.getState().open) return;

      if (e.key === 'Escape') {
        setPortMenu(null);
        setContextMenu(null);
        return;
      }

      if (hasInputFocus || isInputActive()) return;

      const isZ = e.key.toLowerCase() === 'z';
      const isY = e.key.toLowerCase() === 'y';
      const isC = e.key.toLowerCase() === 'c';
      const isV = e.key.toLowerCase() === 'v';
      const isA = e.key.toLowerCase() === 'a';
      const isL = e.key.toLowerCase() === 'l';
      const isShift = e.shiftKey;
      const isCtrl = e.ctrlKey || e.metaKey;

      if (isShift && isL) {
        e.preventDefault();
        window.dispatchEvent(new Event('triggerAutoLayout'));
      } else if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        setPaletteCoords(null);
        setIsPaletteOpen(true);
      } else if (isCtrl && isA) {
        e.preventDefault();
        selectAllNodesRef.current();
      } else if (isCtrl && isZ) {
        e.preventDefault();
        if (isShift) {
          redo();
        } else {
          undo();
        }
      } else if (isCtrl && isY) {
        e.preventDefault();
        redo();
      } else if (isCtrl && isC) {
        e.preventDefault();
        copyNodesRef.current();
      } else if (isCtrl && isV) {
        e.preventDefault();
        pasteNodesRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, hasInputFocus]);

  const onConnect = useCallback(
    (params: Connection) => onStoreConnect(params),
    [onStoreConnect],
  );

  const [lodPortPick, setLodPortPick] = useState<{ x: number; y: number; options: { label: string; connection: Connection }[] } | null>(null);
  const connectingInfo = useRef<{ nodeId: string, handleId: string | null, handleType: 'source' | 'target', portType: string } | null>(null);
  // While a connection is being dragged the focus dimming is lifted, so the
  // target node can be read (2026-09-15).
  const [isConnecting, setIsConnecting] = useState(false);

  const onConnectStart = useCallback((event: any, { nodeId, handleId, handleType }: any) => {
    let portType = 'prompt';
    if (event.target instanceof HTMLElement || event.target instanceof SVGElement) {
      const handleEl = (event.target as Element).closest('[data-porttype]');
      portType = handleEl?.getAttribute('data-porttype') || portType;
    }
    connectingInfo.current = { nodeId, handleId, handleType, portType };
    setIsConnecting(true);
  }, []);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
    setIsConnecting(false);
    if (!connectingInfo.current) return;

    const targetIsHandle = (event.target as Element)?.closest('.react-flow__handle');

    // Outline mode: ports sit a few pixels apart, so a wire dropped anywhere on a
    // node connects to that node's first port that accepts it.
    const from = connectingInfo.current;
    const dropNode = (event.target as Element)?.closest?.('.react-flow__node') as HTMLElement | null;
    if (!connectionState.isValid && dropNode && canvasWrapRef.current?.classList.contains('canvas-lod')
        && dropNode.dataset.id && dropNode.dataset.id !== from.nodeId) {
      const want = from.handleType === 'source' ? 'target' : 'source';
      const options: { label: string; connection: Connection }[] = [];
      for (const el of dropNode.querySelectorAll<HTMLElement>(`.react-flow__handle.${want}`)) {
        const handleId = el.dataset.handleid ?? null;
        const connection: Connection = from.handleType === 'source'
          ? { source: from.nodeId, sourceHandle: from.handleId, target: dropNode.dataset.id, targetHandle: handleId }
          : { source: dropNode.dataset.id, sourceHandle: handleId, target: from.nodeId, targetHandle: from.handleId };
        if (validateConnectionSchema(connection, getNode)) {
          options.push({ label: el.getAttribute('title') || handleId || '', connection });
        }
      }
      // One fit connects at once. Several (first frame vs reference, say) are the
      // user's call, never a guess: pick from a menu at the drop point.
      if (options.length === 1) onConnect(options[0].connection);
      else if (options.length > 1) {
        const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
        setLodPortPick({ x: pt.clientX, y: pt.clientY, options });
      }
      connectingInfo.current = null;
      return;
    }

    // React Flow can report the canvas as event.target even after a handle
    // successfully captured the connection. Its final connection state is the
    // authoritative signal; never open the creation menu over a node/handle.
    if (connectionState.toHandle || connectionState.toNode || targetIsHandle) {
      connectingInfo.current = null;
      return;
    }

    if (!targetIsHandle) {
      const clientX = 'changedTouches' in event ? event.changedTouches[0].clientX : event.clientX;
      const clientY = 'changedTouches' in event ? event.changedTouches[0].clientY : event.clientY;
      const position = screenToFlowPosition({ x: clientX, y: clientY });

      setPortMenu({
        x: clientX,
        y: clientY,
        cx: position.x,
        cy: position.y,
        portType: connectingInfo.current.portType,
        nodeId: connectingInfo.current.nodeId,
        handleType: connectingInfo.current.handleType,
        handleId: connectingInfo.current.handleId,
      });
      setPortSearch('');
      setContextMenu(null);
      justSetPortMenu.current = true;
      setTimeout(() => {
        justSetPortMenu.current = false;
      }, 50);
    }

    connectingInfo.current = null;
  }, [screenToFlowPosition, getNode, onConnect]);

  // Stable handlers for the memoised panels (React.memo is defeated by a new
  // arrow function on every render).
  const closeLibrary = useCallback(() => setIsLibraryOpen(false), []);
  const closePalette = useCallback(() => setIsPaletteOpen(false), []);
  const closeCutRoom = useCallback(() => {
    setIsCutRoomOpen(false);
    if (returnToLibrary) {
      setReturnToLibrary(false);
      setIsLibraryOpen(true);
    }
  }, [returnToLibrary]);
  const isValidConnection = useCallback(
    (connection: Edge | Connection) => validateConnectionSchema(connection, getNode),
    [getNode]
  );

  // ── Highlight connected nodes and edges when nodes are selected ────────────
  // Performance (2026-09-05: dragging a selected node stuttered). Every
  // drag frame replaces the nodes array, and the first version of this memo
  // re-derived the focus sets and re-cloned every dimmed node on each frame, so
  // all ~60 cards re-rendered per frame. Now:
  //   * the focus sets depend only on the selection key and the edges, which do
  //     not change while dragging;
  //   * displayEdges is memoised on the same inputs and is untouched by drags;
  //   * node clones are cached per id by (source object, class) so a drag frame
  //     hands ReactFlow the same objects for every node except the one moving.
  const FOCUS_NODE_RE = /\bnode-(highlight-connected|dimmed)\b/g;
  const FOCUS_EDGE_RE = /\bedge-(highlight-connected|dimmed)\b/g;
  const selectionKey = useMemo(() => {
    const ids: string[] = [];
    nodes.forEach((n) => { if (n.selected) ids.push(n.id); });
    return ids.sort().join('|');
  }, [nodes]);

  const focus = useMemo(() => {
    const selected = new Set(selectionKey ? selectionKey.split('|') : []);
    const connectedEdgeIds = new Set<string>();
    const connectedNodeIds = new Set<string>();
    if (selected.size > 0) {
      edges.forEach((e) => {
        if (selected.has(e.source) || selected.has(e.target)) {
          connectedEdgeIds.add(e.id);
          connectedNodeIds.add(e.source);
          connectedNodeIds.add(e.target);
        }
      });
    }
    return { selected, connectedEdgeIds, connectedNodeIds };
  }, [selectionKey, edges]);

  const hiddenByCollapse = useMemo(() => collapsedMemberIds(nodes), [nodes]);

  const displayEdges = useMemo(() => {
    // `edges` itself stays whole -- autosave and copy read it, and a folded
    // group must not cost the canvas its wiring.
    const shown = hiddenByCollapse.size === 0
      ? edges
      : edges.filter((e) => !hiddenByCollapse.has(e.source) && !hiddenByCollapse.has(e.target));
    if (focus.selected.size === 0) {
      // No selection: nothing may stay dimmed. Stale focus classes can arrive
      // from the store (a canvas saved with them), so strip rather than trust.
      return shown.map((e) => {
        const cls = (e.className || '').replace(FOCUS_EDGE_RE, '').trim();
        return cls === (e.className || '') ? e : { ...e, className: cls };
      });
    }
    // Focus mode: the selection and everything wired to it stay lit, the rest
    // recedes. Connected edges are solid (no dash animation, which shimmers at
    // small zoom), lit by colour only. They are not given a zIndex: a raised edge
    // goes into its own SVG layer above the nodes, and on a 90-node canvas that
    // layer was drawn incomplete and flickered while panning (2026-09-15). Tried
    // again on 2026-09-23 after the backdrop-filter / restyle fixes: it still
    // flickered in focus mode. Keep edges in the one layer under the nodes.
    // Only the connected edges get a class; the rest are dimmed by CSS under
    // `.react-flow.focus-active`, so their objects (and components) are untouched.
    return shown.map((e) => {
      const base = (e.className || '').replace(FOCUS_EDGE_RE, '').trim();
      if (!focus.connectedEdgeIds.has(e.id)) {
        return base === (e.className || '') ? e : { ...e, className: base };
      }
      return {
        ...e,
        className: `${base} edge-highlight-connected`.trim(),
        animated: false,
      };
    });
  }, [edges, hiddenByCollapse, focus]);

  const nodeCloneCache = useRef(new Map<string, { src: Node; cls: string; out: Node }>());
  const displayNodes = useMemo(() => {
    const cache = nodeCloneCache.current;
    const seen = new Set<string>();
    const out = nodes.map((n) => {
      seen.add(n.id);
      const baseClass = (n.className || '').replace(FOCUS_NODE_RE, '').trim();
      // Only connected nodes are re-classed (a handful); unrelated nodes keep
      // their object identity and are dimmed by CSS under `.focus-active`.
      let cls = baseClass;
      if (focus.selected.size > 0 && !focus.selected.has(n.id) && focus.connectedNodeIds.has(n.id)) {
        cls = `${baseClass} node-highlight-connected`.trim();
      }
      if (cls === (n.className || '')) return n;
      const hit = cache.get(n.id);
      if (hit && hit.src === n && hit.cls === cls) return hit.out;
      const clone = { ...n, className: cls };
      cache.set(n.id, { src: n, cls, out: clone });
      return clone;
    });
    for (const id of Array.from(cache.keys())) if (!seen.has(id)) cache.delete(id);
    // Collapsed groups fold their members away; the frame keeps their ids, so
    // nothing is deleted and expanding brings them back where they were.
    const hidden = collapsedMemberIds(out);
    const visible = hidden.size === 0 ? out : out.filter((n) => !hidden.has(n.id));
    return groupsFirst(visible);
  }, [nodes, focus]);

  const closeMenus = useCallback(() => {
    setContextMenu(null);
    setNodeMenu(null);
    setLodPortPick(null);
    if (!justSetPortMenu.current) setPortMenu(null);
  }, []);
  const onPaneClick = useCallback((e: React.MouseEvent) => {
    const now = Date.now();
    if (now - lastClickTime.current < 300) {
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setContextMenu({ x: e.clientX, y: e.clientY, cx: position.x, cy: position.y });
      setContextSearch('');
    } else {
      closeMenus();
    }
    lastClickTime.current = now;
  }, [screenToFlowPosition, closeMenus]);
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    setContextMenu(null);
    setPortMenu(null);
    setCopiedId(null);
    setNodeMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setNodeMenu(null);
  }, []);
  const onSelectionContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setNodeMenu(null);
    setPortMenu(null);
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setContextMenu({ x: e.clientX, y: e.clientY, cx: position.x, cy: position.y });
    setContextSearch('');
  }, [screenToFlowPosition]);
  const onNodesDelete = useCallback((deleted: Node[]) => {
    deleted.forEach((n) => {
      const jobId = (n.data as any)?.jobId;
      if (jobId) api.cancelJob(jobId).catch(() => { });
    });
  }, []);
  const onNodeDragStart = useCallback(() => takeSnapshot(), [takeSnapshot]);
  const onMoveStart = useCallback(() => setNodeMenu(null), []);
  // The zoom, as --rf-zoom, for labels that must stay readable when zoomed out
  // (alias and bible tags scale by its inverse in CSS). It is written into a rule
  // that matches only those tags, not onto the canvas wrapper: an inherited custom
  // property on the wrapper made every zoom frame restyle all ~8,400 elements under
  // it (50 ms/frame on a large scene, vs ~1 ms for the rule; 2026-09-23).
  const zoomRuleRef = useRef<HTMLStyleElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const onMove = useCallback((_event: unknown, viewport: { zoom: number }) => {
    if (zoomRuleRef.current) zoomRuleRef.current.textContent = zoomRule(viewport.zoom);
    // A class on the wrapper, flipped only when the threshold is crossed: one
    // restyle per crossing, none per frame. Not React state -- no re-render.
    canvasWrapRef.current?.classList.toggle('canvas-lod', viewport.zoom < LOD_ZOOM);
    const tier = String(edgeTier(viewport.zoom));
    if (canvasWrapRef.current && canvasWrapRef.current.dataset.edgeTier !== tier) canvasWrapRef.current.dataset.edgeTier = tier;
  }, []);
  const onMoveEnd = useCallback((_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
    if (isLoaded) safeSetItem(localStorage, userScopedKey('cinima-viewport'), JSON.stringify(viewport));
  }, [isLoaded]);

  if (!isLoaded) {
    return <div className="w-full h-screen" style={FLOW_STYLE} />;
  }

  const allAvailableNodes = CREATABLE_NODE_DEFINITIONS.map((def) => ({
    type: def.type,
    label: def.label,
    cat: def.cat,
    color: def.color,
    data: def.createData({ model: selectedModel || 'flux1-dev.safetensors' }),
  }));

  const selectedForGroup = nodes.reduce(
    (count, n) => (n.selected && !isGroupNode(n) ? count + 1 : count), 0);

  const filteredContextMenuNodes = allAvailableNodes.filter((n) => {
    if (!contextSearch) return true;
    const q = contextSearch.toLowerCase();
    return [n.label, n.cat, t(n.label), t(n.cat)]
      .some((field) => field.toLowerCase().includes(q));
  });

  return (
    <div ref={canvasWrapRef} data-edge-tier={edgeTier(initViewport.zoom)} className={`w-full h-screen bg-[#08080a]${initViewport.zoom < LOD_ZOOM ? ' canvas-lod' : ''}`}>
      <style ref={zoomRuleRef}>{zoomRule(initViewport.zoom)}</style>
      <ReactFlow
        className={[
          focus.selected.size > 0 && !isConnecting ? 'focus-active' : '',
        ].join(' ').trim() || undefined}
        defaultViewport={initViewport}
        fitView={shouldFitView}
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodesDelete={onNodesDelete}
        onNodeDragStart={onNodeDragStart}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onPaneClick={onPaneClick}
        onNodeClick={closeMenus}
        onEdgeClick={closeMenus}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onEdgeContextMenu={onPaneContextMenu}
        zoomOnDoubleClick={false}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
        onMove={onMove}
        minZoom={0.08}
        maxZoom={Infinity}
        deleteKeyCode={hasInputFocus ? NO_DELETE_KEYS : DELETE_KEYS}
        style={FLOW_STYLE}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={26}
          size={1.2}
          color="#1e1e26"
        />
        <HelperLines />
        <CanvasBackButton />
        <SelectionBoundingBox />
        <PlayingNodeFloat />
        <NodeSearch />
        <ChainIndex />
        <TemporaryConnectionLine portMenu={portMenu} />
        
        {/* ReactFlow standard Controls styled into floating glass panel */}
        <Controls />
        
        {/* 小地图：不只是看。拖动平移、滚轮缩放、点节点跳过去，
            颜色说的是状态 —— 满画布节点时，"哪个在跑、哪个红了"比"画布长什么样"有用得多。*/}
        <MiniMap
          style={{ background: 'rgba(12, 12, 16, 0.85)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14 }}
          pannable
          zoomable
          // 拖的是视口本身，不是底下的画布 —— 小地图上往右拖，视口就往右走。
          inversePan={false}
          nodeColor={miniMapNodeColor}
          nodeStrokeColor={miniMapNodeStroke}
          nodeStrokeWidth={3}
          onNodeClick={(_, node) => {
            useCanvasNav.getState().remember(getViewport());
            const width = node.measured?.width ?? node.width ?? 0;
            const height = node.measured?.height ?? node.height ?? 0;
            setCenter(node.position.x + width / 2, node.position.y + height / 2, {
              zoom: Math.max(getViewport().zoom, 0.6),
              duration: 300,
            });
            // 跳过去还要选中：否则落地之后还得在一堆节点里找刚才点的是哪个。
            setReactFlowNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id })));
          }}
          // 空白处单击：按当前缩放把视口移过去。拖动由 pannable 负责，
          // 单击补的是"一眼看到远处那一片，直接过去"。
          onClick={(_, position) =>
            setCenter(position.x, position.y, { zoom: getViewport().zoom, duration: 200 })
          }
          maskColor="rgba(0,0,0,0.7)"
        />

        {/* ── Studio Top Header Bar ────────────────────────── */}
        <HeaderBar />
        <SceneBar />

        {/* An agent holds the project lock: auto-save is paused so its writes
            land intact. Cleared by the 3 s poll once the lock is released. */}
        {agentLock && (
          <div
            className="fixed top-14 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-200 border border-amber-400/40 pointer-events-none select-none"
            style={{ background: 'rgba(60, 40, 10, 0.85)', backdropFilter: 'blur(12px)' }}
            title={agentLock.reason || ''}
          >
            🔒 {agentLock.agent === 'claude' ? '克' : agentLock.agent === 'antigravity' ? '安' : agentLock.agent}{' '}
            {t('正在写画布，自动保存已暂停')}
            {agentLock.reason ? ` · ${agentLock.reason}` : ''}
          </div>
        )}

        {/* ── Higgsfield Signature Bottom Dock ─────────────── */}
        <BottomDock />

        {/* ── Asset Library: everything generated, and what uses it ── */}
        <AssetLibrary isOpen={isLibraryOpen} onClose={closeLibrary} />

        {/* ── Cut Room: multi-track editor over the canvas ──── */}
        <CutRoom isOpen={isCutRoomOpen} onClose={closeCutRoom} />

        {/* ── Quick Node Spotlight Palette ─────────────────── */}
        <QuickNodePalette
          isOpen={isPaletteOpen}
          onClose={closePalette}
          spawnCoords={paletteCoords}
        />

        {/* ── Empty Canvas Cinema Welcome Banner ───────────── */}
        {nodes.length === 0 && (
          <Panel position="bottom-center">
            <div 
              className="text-center pb-24 space-y-2 pointer-events-auto select-none"
              style={{ transform: 'translateY(-20px)' }}
            >
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-zinc-400 text-xs font-mono mb-2">
                <span className="text-zinc-400">✦</span>
                <span>{t('LAZA CINEMA STUDIO · 无限影视画布已就绪')}</span>
              </div>
              <p className="text-zinc-400 text-sm font-medium">
                
                {t('从底部工具栏添加第一个节点开始创作')}
              </p>
              <p className="text-zinc-500 text-xs font-mono">
                
                {t('双击空白画布快速添加节点 · 拖动输出端口自动连线 · 空格键呼出节点面板')}
              </p>
            </div>
          </Panel>
        )}

        {/* ── Double-Click Searchable Context Menu ──────────── */}
        {lodPortPick && typeof document !== 'undefined' && createPortal(
          <div
            style={{
              position: 'fixed',
              top: Math.min(window.innerHeight - 40 - lodPortPick.options.length * 34, lodPortPick.y),
              left: Math.min(window.innerWidth - 270, lodPortPick.x),
              zIndex: 1000,
            }}
            className="w-64 p-1.5 rounded-2xl glass-dock shadow-2xl flex flex-col gap-1"
            onMouseLeave={() => setLodPortPick(null)}
          >
            <div className="px-2 pt-1 pb-0.5 text-[10px] text-zinc-500">{t('连到哪个端口')}</div>
            {lodPortPick.options.map((option) => (
              <button
                key={option.connection.targetHandle ?? option.connection.sourceHandle ?? option.label}
                onClick={() => {
                  onConnect(option.connection);
                  setLodPortPick(null);
                }}
                className="w-full px-2.5 py-2 rounded-xl text-left text-xs text-zinc-200 bg-white/[0.04] hover:bg-white/[0.12] border border-white/[0.06] transition-colors cursor-pointer truncate"
              >
                {option.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
        {contextMenu && typeof document !== 'undefined' && createPortal(
          <div
            style={{
              position: 'fixed',
              top: Math.min(window.innerHeight - 380, contextMenu.y),
              left: Math.min(window.innerWidth - 330, contextMenu.x),
              zIndex: 1000,
            }}
            className="w-80 p-2.5 rounded-2xl glass-dock animate-in fade-in zoom-in-95 duration-150 shadow-2xl flex flex-col gap-1.5 max-h-[380px]"
          >
            {/* Search Input */}
            <div className="px-2 py-1.5 mb-1 bg-white/[0.04] rounded-xl border border-white/[0.06] flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                autoFocus
                placeholder={t('搜索电影节点…')}
                className="w-full bg-transparent border-none outline-none text-xs text-white placeholder-zinc-500"
                value={contextSearch}
                onChange={(e) => setContextSearch(e.target.value)}
              />
            </div>

            {/* Grouping: a frame, not a generator, so it sits above the
                node search rather than inside it. */}
            <button
              onClick={() => {
                createGroup({ x: contextMenu.cx, y: contextMenu.cy });
                setContextMenu(null);
              }}
              className="w-full px-2.5 py-2 mb-1 rounded-xl text-left text-xs text-zinc-200 bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.06] transition-colors cursor-pointer flex items-center gap-2"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                <path d="M1.5 6 H14.5" />
              </svg>
              {selectedForGroup > 0
                ? t('把选中的 {n} 个节点框成分组', { n: selectedForGroup })
                : t('新建空分组')}
            </button>

            {/* Nodes list */}
            <div className="flex-1 overflow-y-auto space-y-0.5 pr-1">
              {filteredContextMenuNodes.map(item => (
                <button
                  key={item.type}
                  className="w-full flex items-center justify-between px-2.5 py-2 rounded-xl text-left text-xs text-zinc-300 hover:text-white hover:bg-white/[0.08] transition-all cursor-pointer group"
                  onClick={(e) => {
                    e.stopPropagation();
                    takeSnapshot();
                    const currentPosition = screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y });
                    const dims = DEFAULT_NODE_DIMENSIONS[item.type] || { width: 280, height: 280 };
                    setNodes(nodes.concat({
                      id: `${item.type}-${Date.now()}`,
                      type: item.type,
                      position: { x: currentPosition.x, y: currentPosition.y },
                      width: dims.width,
                      height: dims.height,
                      data: item.data
                    }));
                    setContextMenu(null);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span 
                      className="w-2 h-2 rounded-full" 
                      style={{ background: item.color }} 
                    />
                    <span className="font-medium">{t(item.label)}</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 font-mono group-hover:text-zinc-400">
                    {t(item.cat)}
                  </span>
                </button>
              ))}
              {filteredContextMenuNodes.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-zinc-500">
                  
                  {t('未找到匹配的节点')}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}

        {/* ── Node Right-Click Menu ─────────────────────────── */}
        {nodeMenu && typeof document !== 'undefined' && createPortal(
          <div
            style={{
              position: 'fixed',
              top: Math.min(window.innerHeight - 120, nodeMenu.y),
              left: Math.min(window.innerWidth - 240, nodeMenu.x),
              zIndex: 1001,
            }}
            className="w-56 p-1.5 rounded-2xl glass-dock animate-in fade-in zoom-in-95 duration-150 shadow-2xl flex flex-col gap-0.5"
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              className="w-full flex items-center justify-between px-2.5 py-2 rounded-xl text-left text-xs text-zinc-300 hover:text-white hover:bg-white/[0.08] transition-all cursor-pointer"
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(nodeMenu.nodeId);
                } catch {
                  // Clipboard is blocked outside a secure context; fall back to
                  // a hidden textarea so the id can still be copied.
                  const ta = document.createElement('textarea');
                  ta.value = nodeMenu.nodeId;
                  ta.style.position = 'fixed';
                  ta.style.opacity = '0';
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  document.body.removeChild(ta);
                }
                setCopiedId(nodeMenu.nodeId);
                setTimeout(() => setNodeMenu(null), 450);
              }}
            >
              <span className="font-medium">{t('复制节点 ID')}</span>
              <span className="text-[10px] text-emerald-400 font-mono">
                {copiedId === nodeMenu.nodeId ? t('已复制') : ''}
              </span>
            </button>
            <div className="px-2.5 pb-1 pt-0.5 text-[10px] text-zinc-500 font-mono truncate select-text">
              {nodeMenu.nodeId}
            </div>
          </div>,
          document.body
        )}

        {/* ── Port Menu (Single-click / Drag-release Popup) ────────────────────────── */}
        {portMenu && (() => {
          const currentNode = nodes.find(n => n.id === portMenu.nodeId);
          const rawItems = getPortMenuItems(portMenu, selectedModel || 'flux1-dev.safetensors', currentNode);
          const existingNodes = getExistingCompatibleNodesOnCanvas({
            portType: portMenu.portType,
            handleType: portMenu.handleType,
            handleId: portMenu.handleId,
            currentNodes: nodes,
            currentNodeId: portMenu.nodeId,
            currentEdges: edges,
          });

          const matches = (fields: Array<string | null | undefined>) => {
            if (!portSearch) return true;
            const q = portSearch.toLowerCase();
            // the source text and the translation, so search works in either language
            return fields.some((f) => f && (f.toLowerCase().includes(q) || t(f).toLowerCase().includes(q)));
          };

          const filteredExisting = existingNodes.filter(
            (n) => matches([n.label, n.alias, n.previewText, n.cat]));

          const filteredCreate = rawItems.filter((item) => matches([item.label, item.cat]));

          const handleConnectExisting = (existing: ExistingCompatibleNode) => {
            takeSnapshot();
            const isSource = portMenu.handleType === 'source';
            const srcNodeId = isSource ? portMenu.nodeId : existing.nodeId;
            const srcHandle = isSource ? (portMenu.handleId || undefined) : existing.sourceHandle;
            const tgtNodeId = isSource ? existing.nodeId : portMenu.nodeId;
            const tgtHandle = isSource ? existing.targetHandle : (portMenu.handleId || undefined);

            if (existing.isConnected && existing.edgeId) {
              // Disconnect toggle
              setEdges(edges.filter(e => e.id !== existing.edgeId));
              setPortMenu(null);
              return;
            }

            const targetNode = nodes.find(n => n.id === tgtNodeId);
            const isSingleInput = (targetNode?.type === 'video' && tgtHandle === 'in-image') ||
                                  (EDIT_FAMILY.has(targetNode?.type as string) && (tgtHandle === 'in-first-frame' || tgtHandle === 'in-last-frame' || tgtHandle === 'in-video')) ||
                                  (targetNode?.type === 'videoUpscale' && tgtHandle === 'in-video') ||
                                  (targetNode?.type === 'videoInterpolate' && tgtHandle === 'in-video') ||
                                  (targetNode?.type === 'videoTrim' && tgtHandle === 'in-video') ||
                                  (targetNode?.type === 'depthVideo' && tgtHandle === 'in-video');

            const newEdge = {
              id: `e-${Date.now()}`,
              source: srcNodeId,
              sourceHandle: srcHandle,
              target: tgtNodeId,
              targetHandle: tgtHandle,
            };

            let baseEdges = edges;
            if (isSingleInput) {
              baseEdges = baseEdges.filter(e => !(e.target === tgtNodeId && e.targetHandle === tgtHandle));
            }
            setEdges(baseEdges.concat(newEdge));
            setPortMenu(null);
          };

          if (typeof document === 'undefined') return null;

          return createPortal(
            <div
              style={{
                position: 'fixed',
                top: Math.min(window.innerHeight - 480, Math.max(10, portMenu.y - 30)),
                left: Math.min(window.innerWidth - 440, Math.max(10, portMenu.x + 15)),
                zIndex: 1000,
              }}
              className="w-[410px] p-3 rounded-2xl glass-dock animate-in fade-in zoom-in-95 duration-150 shadow-2xl flex flex-col gap-2.5 max-h-[480px] select-none"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="px-1.5 py-1 text-[11px] text-zinc-300 font-mono font-semibold tracking-wide border-b border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-white/80 shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
                  <span>{portMenu.handleType === 'source' ? t('可连接目标端口') : t('可连接来源节点')}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {existingNodes.length > 0 && (
                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-white/10 text-zinc-300 border border-white/15 font-mono">
                      {existingNodes.length}{t('个画布已有')}
                    </span>
                  )}
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-zinc-300 border border-white/15 font-mono font-medium">
                    {portMenu.portType}
                  </span>
                </div>
              </div>

              {/* Search filter */}
              <div className="px-2.5 py-1.5 bg-white/[0.04] rounded-xl border border-white/[0.06] flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2.5">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  autoFocus
                  placeholder={t('搜索画布已有节点或新建类型…')}
                  className="w-full bg-transparent border-none outline-none text-xs text-white placeholder-zinc-500"
                  value={portSearch}
                  onChange={(e) => setPortSearch(e.target.value)}
                />
              </div>

              {/* Items Container with Sections */}
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 max-h-[360px] no-scrollbar">
                {/* SECTION 1: 画布已有节点 */}
                {filteredExisting.length > 0 && (
                  <div>
                    <div className="px-2 pb-1.5 text-[10px] font-mono text-zinc-300 font-semibold flex items-center gap-1.5 tracking-wider">
                      <span className="w-1.5 h-1.5 rounded-full bg-white/80 shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
                      <span>{t('画布已有可连接节点 ({n})', { n: filteredExisting.length })}</span>
                    </div>
                    <div className="space-y-1">
                      {filteredExisting.map((item) => (
                        <button
                          key={`existing-${item.nodeId}-${item.sourceHandle || ''}-${item.targetHandle || ''}`}
                          className={`w-full flex items-center justify-between px-2.5 py-2 rounded-xl text-left text-xs transition-all cursor-pointer group gap-2.5 border ${
                            item.isConnected
                              ? 'bg-white/[0.08] hover:bg-red-500/20 border-white/20 hover:border-red-500/50 text-zinc-200 hover:text-red-200'
                              : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/5 hover:border-white/15 text-zinc-200 hover:text-white'
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleConnectExisting(item);
                          }}
                        >
                          {/* Thumbnail / Icon */}
                          <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-black/40 border border-white/10 flex items-center justify-center relative">
                            {item.thumbnailUrl ? (
                              item.thumbnailUrl.endsWith('.mp4') || item.thumbnailUrl.endsWith('.webm') ? (
                                <img
                                  src={posterUrl(`${API_BASE}${item.thumbnailUrl}`) ?? ''}
                                  alt=""
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <img
                                  src={item.thumbnailUrl.startsWith('http') || item.thumbnailUrl.startsWith('blob:') ? item.thumbnailUrl : `${API_BASE}${item.thumbnailUrl}`}
                                  alt=""
                                  className="w-full h-full object-cover"
                                />
                              )
                            ) : (
                              <span
                                className="w-3 h-3 rounded-full"
                                style={{ background: item.color || '#a1a1aa', boxShadow: `0 0 8px ${item.color || '#a1a1aa'}` }}
                              />
                            )}
                          </div>

                          {/* Node info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              {item.alias && (
                                <span className="px-1.5 py-0.2 rounded bg-white/10 text-zinc-300 border border-white/15 text-[9px] font-sans font-medium truncate max-w-[90px]">
                                  🏷️ {item.alias}
                                </span>
                              )}
                              <span className="font-medium text-xs truncate">{t(item.label)}</span>
                            </div>
                            {item.previewText && (
                              <p className="text-[10px] text-zinc-400 truncate leading-tight">
                                {item.previewText}
                              </p>
                            )}
                          </div>

                          {/* Status / Connect Action */}
                          <div className="flex-shrink-0">
                            {item.isConnected ? (
                              <>
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-white/10 text-zinc-300 border border-white/15 group-hover:hidden">
                                  {t('已连接')} ✓
                                </span>
                                <span className="hidden group-hover:inline-block px-2 py-0.5 rounded-full text-[10px] font-mono bg-red-500/25 text-red-300 border border-red-500/50">
                                  {t('断开')} ✕
                                </span>
                              </>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-white/10 text-zinc-200 border border-white/15 group-hover:bg-white/20 group-hover:border-white/30 transition-all">
                                + {t('直连')}
                              </span>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* SECTION 2: 新建并连接 */}
                {filteredCreate.length > 0 && (
                  <div>
                    <div className="px-2 pb-1.5 text-[10px] font-mono text-zinc-300 font-semibold flex items-center gap-1.5 tracking-wider">
                      <span className="w-1.5 h-1.5 rounded-full bg-white/80 shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
                      <span>{t('新建节点并连接 ({n})', { n: filteredCreate.length })}</span>
                    </div>
                    <div className="space-y-1">
                      {filteredCreate.map((item, idx) => (
                        <button
                          key={`create-${item.type}-${item.targetHandle || ''}-${item.label}-${idx}`}
                          className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-left text-xs text-zinc-300 hover:text-white hover:bg-white/[0.08] transition-all cursor-pointer group gap-2 bg-white/[0.02] border border-white/[0.04]"
                          onClick={(e) => {
                            e.stopPropagation();
                            const newNodeId = `${item.type}-${Date.now()}`;
                            const currentPosition = screenToFlowPosition({ x: portMenu.x, y: portMenu.y });
                            const dims = DEFAULT_NODE_DIMENSIONS[item.type] || { width: 280, height: 280 };
                            takeSnapshot();
                            setNodes(nodes.concat({
                              id: newNodeId,
                              type: item.type,
                              position: { x: currentPosition.x, y: currentPosition.y },
                              width: dims.width,
                              height: dims.height,
                              data: item.data,
                              style: item.style
                            }));
                            setTimeout(() => {
                              setEdges(edges.concat({
                                id: `e-${Date.now()}`,
                                source: portMenu.handleType === 'source' ? portMenu.nodeId : newNodeId,
                                sourceHandle: portMenu.handleType === 'source' ? (portMenu.handleId || undefined) : (item.sourceHandle || undefined),
                                target: portMenu.handleType === 'target' ? portMenu.nodeId : newNodeId,
                                targetHandle: portMenu.handleType === 'target' ? (portMenu.handleId || undefined) : (item.targetHandle || undefined),
                              }));
                            }, 50);
                            setPortMenu(null);
                          }}
                        >
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            <span
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ background: item.color || '#a78bfa', boxShadow: `0 0 6px ${item.color || '#a78bfa'}80` }}
                            />
                            <span className="font-medium whitespace-normal leading-snug">{t(item.label)}</span>
                          </div>
                          {item.cat && (
                            <span className="text-[10px] text-zinc-400 font-mono flex-shrink-0 px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.06] group-hover:text-zinc-300 group-hover:border-white/10">
                              {t(item.cat)}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {filteredExisting.length === 0 && filteredCreate.length === 0 && (
                  <div className="px-3 py-6 text-center text-xs text-zinc-500">
                    {t('没有找到匹配的兼容节点')}
                  </div>
                )}
              </div>
            </div>,
            document.body
          );
        })()}
      </ReactFlow>
    </div>
  );
}

function getPortMenuItems(menu: any, model: string, sourceNode?: Node) {
  return getCompatibleNodesForPort({
    portType: menu.portType,
    handleType: menu.handleType,
    handleId: menu.handleId,
    model,
    sourceNode,
  });
}

/**
 * 小地图上的节点颜色按**状态**给，不按类型。
 *
 * 画布上几十个节点时，缩到小地图那个尺寸，类型是分不出来的；而"哪一条在渲染、
 * 哪一条报错了、我刚选中的在哪"是真的要找的三件事。
 */
function miniMapNodeColor(node: Node): string {
  if (node.selected) return '#34d399';
  const status = (node.data as { status?: unknown } | undefined)?.status;
  if (status === 'generating' || status === 'capturing' || status === 'saving') return '#f59e0b';
  if (status === 'error') return '#f87171';
  return '#27272a';
}

/** 选中的节点在小地图上只有几个像素，描边是唯一看得见的区别。 */
function miniMapNodeStroke(node: Node): string {
  return node.selected ? '#34d399' : 'rgba(255,255,255,0.12)';
}

export default function InfiniteCanvas() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
