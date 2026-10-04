import { RETIRED_NODE_TYPES } from './nodeRegistry';
import { type Node, type Edge, addEdge } from '@xyflow/react';
import { calculateCinemaLayout } from './layoutEngine';
import { t } from './i18n';

export interface CanvasAction {
  action: 'create_node' | 'connect' | 'update_node' | 'delete_node' | 'auto_layout' | 'clean_isolated' | 'clear_canvas' | 'select_nodes';
  temp_id?: string;
  id?: string;
  node_type?: string;
  data?: Record<string, any>;
  position?: { x: number; y: number };
  source?: string;
  source_handle?: string;
  target?: string;
  target_handle?: string;
}

export interface ExecutionResult {
  success: boolean;
  message: string;
  createdNodeCount: number;
  connectedEdgeCount: number;
  updatedNodeCount: number;
  deletedNodeCount: number;
  logs: string[];
}

/**
 * Returns default data payload for a specific node type
 */
export function getDefaultNodeData(nodeType: string, customData: Record<string, any> = {}, selectedModel?: string): Record<string, any> {
  const model = customData.model || selectedModel || 'flux2_dev_fp8mixed.safetensors';

  switch (nodeType) {
    case 'prompt':
      return {
        text: customData.text ?? customData.prompt ?? '',
      };
    case 'image':
      return {
        url: customData.url ?? null,
        mediaType: customData.mediaType ?? 'image',
      };
    case 'preview':
      return {};
    default:
      return { ...customData };
  }
}

/**
 * Executes a list of AI Assistant actions on the ReactFlow canvas state
 */
export function executeCanvasActions(
  actions: CanvasAction[],
  currentNodes: Node[],
  currentEdges: Edge[],
  takeSnapshot: () => void,
  setNodes: (nodes: Node[]) => void,
  setEdges: (edges: Edge[]) => void,
  selectedModel?: string
): ExecutionResult {
  if (!actions || actions.length === 0) {
    return {
      success: true,
      message: t('没有需要执行的画布动作'),
      createdNodeCount: 0,
      connectedEdgeCount: 0,
      updatedNodeCount: 0,
      deletedNodeCount: 0,
      logs: [],
    };
  }

  // Save history snapshot before modifying anything
  takeSnapshot();

  let nextNodes: Node[] = currentNodes.map((n) => ({ ...n, selected: false }));
  let nextEdges: Edge[] = [...currentEdges];

  const tempIdToRealId = new Map<string, string>();
  const logs: string[] = [];

  let createdCount = 0;
  let connectedCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;

  // Track max existing X to place new disconnected workflows safely to the right
  let maxX = nextNodes.reduce((max, n) => Math.max(max, n.position.x + 360), 100);
  let defaultBaseY = nextNodes.length > 0 ? (nextNodes[0].position.y || 100) : 100;

  // Process actions sequentially
  for (let i = 0; i < actions.length; i++) {
    const act = actions[i];

    switch (act.action) {
      case 'clear_canvas': {
        nextNodes = [];
        nextEdges = [];
        logs.push(t('已清空画布所有节点与连线'));
        break;
      }

      case 'clean_isolated': {
        const connectedNodeIds = new Set<string>();
        nextEdges.forEach((e) => {
          connectedNodeIds.add(e.source);
          connectedNodeIds.add(e.target);
        });
        const beforeCount = nextNodes.length;
        nextNodes = nextNodes.filter((n) => connectedNodeIds.has(n.id));
        const removed = beforeCount - nextNodes.length;
        deletedCount += removed;
        logs.push(t('已清理 {v1} 个孤立未连接节点', { v1: removed }));
        break;
      }

      case 'create_node': {
        if (!act.node_type) break;
        // The assistant's plan can still name a retired type (it was trained on
        // canvases that had them); skip it and say so rather than put a node on
        // the canvas that cannot run.
        if (RETIRED_NODE_TYPES.has(act.node_type)) {
          logs.push(t('跳过已停用的节点类型 [{v1}]：生图改用 H3 渲染 + 抽帧', { v1: act.node_type }));
          break;
        }

        const nodeType = act.node_type;
        const realId = `${nodeType}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        if (act.temp_id) {
          tempIdToRealId.set(act.temp_id, realId);
        }

        // Determine position
        let pos = act.position;
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
          pos = { x: maxX + createdCount * 360, y: defaultBaseY };
        }

        const data = getDefaultNodeData(nodeType, act.data || {}, selectedModel);

        const newNode: Node = {
          id: realId,
          type: nodeType,
          position: { x: Math.round(pos.x), y: Math.round(pos.y) },
          data,
          selected: true,
        };

        nextNodes.push(newNode);
        createdCount++;
        const nodeTitle = data.text ? `"${data.text.substring(0, 15)}..."` : nodeType;
        logs.push(t('创建节点 [{v1}] {v2}', { v1: nodeType, v2: nodeTitle }));
        break;
      }

      case 'connect': {
        const rawSource = act.source;
        const rawTarget = act.target;
        if (!rawSource || !rawTarget) break;

        const sourceId = tempIdToRealId.get(rawSource) || rawSource;
        const targetId = tempIdToRealId.get(rawTarget) || rawTarget;

        const sourceNode = nextNodes.find((n) => n.id === sourceId);
        const targetNode = nextNodes.find((n) => n.id === targetId);

        if (!sourceNode || !targetNode) {
          logs.push(t('⚠️ 连线失败：找不到节点 {v1} 或 {v2}', { v1: rawSource, v2: rawTarget }));
          break;
        }

        // Infer target handle if not provided
        let targetHandle = act.target_handle;
        if (!targetHandle) {
          if (sourceNode.type === 'prompt') targetHandle = 'in-prompt';
          else if (['image', 'inpaint', 'pose', 'gaussian'].includes(sourceNode.type as string)) {
            targetHandle = 'in-image';
          } else if (['video', 'videoUpscale', 'videoInterpolate', 'videoTrim', 'depthVideo'].includes(sourceNode.type as string)) {
            targetHandle = 'in-video';
          } else if (sourceNode.type === 'audioGen') {
            targetHandle = ['videoEdit', 'videoContinue', 'videoFrames'].includes(targetNode.type as string) ? 'in-audio' : 'in-ref-audio';
          }
        }

        // Enforce single connection per target handle
        nextEdges = nextEdges.filter(
          (e) => !(e.target === targetId && e.targetHandle === targetHandle)
        );

        const newEdge: Edge = {
          id: `e-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          source: sourceId,
          sourceHandle: act.source_handle || undefined,
          target: targetId,
          targetHandle: targetHandle || undefined,
          animated: false,
          style: { stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1.5 },
        };

        nextEdges.push(newEdge);
        connectedCount++;
        logs.push(t('连接 [{v1}] ➔ [{v2}] ({v3})', { v1: sourceNode.type ?? '', v2: targetNode.type ?? '', v3: targetHandle || 'default' }));
        break;
      }

      case 'update_node': {
        const rawId = act.id || act.temp_id;
        if (!rawId) break;

        const targetId = tempIdToRealId.get(rawId) || rawId;
        const nodeIndex = nextNodes.findIndex((n) => n.id === targetId);

        if (nodeIndex !== -1 && act.data) {
          const oldNode = nextNodes[nodeIndex];
          nextNodes[nodeIndex] = {
            ...oldNode,
            data: {
              ...oldNode.data,
              ...act.data,
            },
            selected: true,
          };
          updatedCount++;
          logs.push(t('更新节点 [{v1}] {v2}', { v1: oldNode.type ?? '', v2: targetId }));
        }
        break;
      }

      case 'delete_node': {
        const rawId = act.id || act.temp_id;
        if (!rawId) break;

        const targetId = tempIdToRealId.get(rawId) || rawId;
        nextNodes = nextNodes.filter((n) => n.id !== targetId);
        nextEdges = nextEdges.filter((e) => e.source !== targetId && e.target !== targetId);
        deletedCount++;
        logs.push(t('删除节点 {v1}', { v1: targetId }));
        break;
      }

      case 'auto_layout': {
        nextNodes = calculateCinemaLayout(nextNodes, nextEdges);
        logs.push(t('已自动重新排列画布节点 (影视分镜泳道与 DAG 排版)'));
        break;
      }

      default:
        break;
    }
  }

  // Update store states
  setNodes(nextNodes);
  setEdges(nextEdges);

  return {
    success: true,
    message: t('执行完毕：新增 {v1} 个节点，建立 {v2} 条连线，更新 {v3} 个节点', { v1: createdCount, v2: connectedCount, v3: updatedCount }),
    createdNodeCount: createdCount,
    connectedEdgeCount: connectedCount,
    updatedNodeCount: updatedCount,
    deletedNodeCount: deletedCount,
    logs,
  };
}

/**
 * Calculates a clean hierarchical cinema layout (left to right) for nodes
 * Re-exported for backward compatibility
 */
export function calculateDagLayout(nodes: Node[], edges: Edge[]): Node[] {
  return calculateCinemaLayout(nodes, edges);
}
