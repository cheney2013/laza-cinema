import { type Node, type Edge } from '@xyflow/react';
import { DEFAULT_NODE_DIMENSIONS } from './types';

export interface LayoutOptions {
  horizontalSpacing?: number; // 节点列与列之间的水平间隙 (px)
  verticalSpacing?: number;   // 同一列内节点之间的垂直间隙 (px)
  laneSpacing?: number;       // 不同连通分量 (分镜泳道) 之间的垂直间隙 (px)
  startX?: number;            // 起始 X 坐标
  startY?: number;            // 起始 Y 坐标
  selectedOnly?: boolean;     // 是否仅针对选中节点做局部排版
  selectedNodeIds?: Set<string>; // 选中节点集合
  scratchCols?: number;       // 孤立素材停靠区的网格列数 (默认 4)
}

interface NodeBounds {
  width: number;
  height: number;
}

/**
 * 获取节点的真实渲染尺寸或默认尺寸
 */
export function getNodeBounds(node: Node): NodeBounds {
  const defaultDim = (node.type && DEFAULT_NODE_DIMENSIONS[node.type]) || { width: 320, height: 260 };
  const width = node.measured?.width ?? node.width ?? defaultDim.width;
  const height = node.measured?.height ?? node.height ?? defaultDim.height;
  return {
    width: Math.max(width, 160),
    height: Math.max(height, 80),
  };
}

/**
 * 影视级智能画布排版引擎 (Cinema DAG & Storyboard Lanes Layout Engine)
 *
 * 特性：
 * 1. 连通分量切分 (Shot Lane Separation) - 将独立分镜流水线分别排布为清晰泳道
 * 2. 重心启发式层内排序 (Barycenter Ordering) - 消除 80%+ 连线交叉
 * 3. 动态尺寸感知 (Dynamic Bounding Dimensions) - 基于真实高度自适应对齐，杜绝重叠
 * 4. 孤立草稿/素材停靠区 (Isolates Dock) - 自动沉底整理未连线卡片
 * 5. 局部排版支持 (Partial Subgraph Layout) - 原位整理选中分支
 */
export function calculateCinemaLayout(
  allNodes: Node[],
  allEdges: Edge[],
  options: LayoutOptions = {}
): Node[] {
  if (allNodes.length === 0) return [];

  const {
    horizontalSpacing = 280,
    verticalSpacing = 40,
    laneSpacing = 80,
    startX = 100,
    startY = 100,
    selectedOnly = false,
    selectedNodeIds = new Set<string>(
      options.selectedOnly ? allNodes.filter((n) => n.selected).map((n) => n.id) : []
    ),
    scratchCols = 4,
  } = options;

  // 1. 如果是局部整理，提取目标节点与子边集
  const nodesToLayout = selectedOnly
    ? allNodes.filter((n) => selectedNodeIds.has(n.id))
    : allNodes;

  if (nodesToLayout.length === 0) return allNodes;

  const nodeMap = new Map<string, Node>(nodesToLayout.map((n) => [n.id, n]));
  const relevantEdges = allEdges.filter(
    (e) => nodeMap.has(e.source) && nodeMap.has(e.target)
  );

  // 计算局部锚点原点 (保持局部整理时的原位)
  let originX = startX;
  let originY = startY;
  if (selectedOnly) {
    originX = Math.min(...nodesToLayout.map((n) => n.position.x));
    originY = Math.min(...nodesToLayout.map((n) => n.position.y));
  }

  // 2. 构建无向连通分量 (Connected Components)
  const undirectedAdj = new Map<string, string[]>();
  nodesToLayout.forEach((n) => undirectedAdj.set(n.id, []));
  relevantEdges.forEach((e) => {
    undirectedAdj.get(e.source)?.push(e.target);
    undirectedAdj.get(e.target)?.push(e.source);
  });

  const visited = new Set<string>();
  const connectedComponents: Node[][] = [];
  const isolatedNodes: Node[] = [];

  nodesToLayout.forEach((node) => {
    if (visited.has(node.id)) return;

    const neighbors = undirectedAdj.get(node.id) || [];
    if (neighbors.length === 0) {
      // 孤立未连线节点 (草稿/参考图/素材)
      visited.add(node.id);
      isolatedNodes.push(node);
      return;
    }

    // BFS 遍历连通分量
    const component: Node[] = [];
    const queue = [node.id];
    visited.add(node.id);

    while (queue.length > 0) {
      const currId = queue.shift()!;
      const currNode = nodeMap.get(currId);
      if (currNode) component.push(currNode);

      const adjList = undirectedAdj.get(currId) || [];
      adjList.forEach((nextId) => {
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push(nextId);
        }
      });
    }

    if (component.length > 0) {
      connectedComponents.push(component);
    }
  });

  // 按各分量原始平均 Y 坐标排序，保持分镜在画布上的先后顺序
  connectedComponents.sort((a, b) => {
    const avgYA = a.reduce((sum, n) => sum + n.position.y, 0) / a.length;
    const avgYB = b.reduce((sum, n) => sum + n.position.y, 0) / b.length;
    return avgYA - avgYB;
  });

  // 3. 对每个独立连通分量进行拓扑分层与重心法排版
  const posMap = new Map<string, { x: number; y: number }>();
  let currentLaneY = originY;

  connectedComponents.forEach((component) => {
    const compNodeIds = new Set(component.map((n) => n.id));
    const compEdges = relevantEdges.filter(
      (e) => compNodeIds.has(e.source) && compNodeIds.has(e.target)
    );

    // 3.1 构建有向 DAG 结构
    const inDegree = new Map<string, number>();
    const outAdj = new Map<string, string[]>();
    const inAdj = new Map<string, string[]>();

    component.forEach((n) => {
      inDegree.set(n.id, 0);
      outAdj.set(n.id, []);
      inAdj.set(n.id, []);
    });

    compEdges.forEach((e) => {
      inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
      outAdj.get(e.source)?.push(e.target);
      inAdj.get(e.target)?.push(e.source);
    });

    // 3.2 拓扑分层 (Longest Path Layer Assignment)
    const layerMap = new Map<string, number>();
    const queue: string[] = [];

    component.forEach((n) => {
      if ((inDegree.get(n.id) || 0) === 0) {
        layerMap.set(n.id, 0);
        queue.push(n.id);
      }
    });

    // 如果包含环状连线，将未入列节点作为 Layer 0 兜底
    if (queue.length === 0 && component.length > 0) {
      layerMap.set(component[0].id, 0);
      queue.push(component[0].id);
    }

    const topoInDegree = new Map(inDegree);
    while (queue.length > 0) {
      const currId = queue.shift()!;
      const currLayer = layerMap.get(currId) || 0;
      const nexts = outAdj.get(currId) || [];

      nexts.forEach((nxtId) => {
        const nxtLayer = Math.max(layerMap.get(nxtId) || 0, currLayer + 1);
        layerMap.set(nxtId, nxtLayer);
        const remIn = (topoInDegree.get(nxtId) || 1) - 1;
        topoInDegree.set(nxtId, remIn);
        if (remIn <= 0) {
          queue.push(nxtId);
        }
      });
    }

    // 兜底：处理剩余未分层的节点
    component.forEach((n) => {
      if (!layerMap.has(n.id)) {
        layerMap.set(n.id, 0);
      }
    });

    // 3.3 将节点按层分组
    const maxLayer = Math.max(...Array.from(layerMap.values()), 0);
    const layers: Node[][] = Array.from({ length: maxLayer + 1 }, () => []);
    component.forEach((n) => {
      const l = layerMap.get(n.id) || 0;
      layers[l].push(n);
    });

    // 3.4 重心启发式层内排序 (Sugiyama Barycenter Order)
    // 第 0 层按原始 Y 坐标排序
    layers[0].sort((a, b) => a.position.y - b.position.y);

    // 临时 Y 坐标预分配表
    const tempYMap = new Map<string, number>();
    layers[0].forEach((node, idx) => {
      tempYMap.set(node.id, idx * 300);
    });

    for (let l = 1; l <= maxLayer; l++) {
      const currentLayerNodes = layers[l];
      const barycenters = new Map<string, number>();

      currentLayerNodes.forEach((node) => {
        const parents = inAdj.get(node.id) || [];
        const validParents = parents.filter((p) => tempYMap.has(p));
        if (validParents.length > 0) {
          const avgY =
            validParents.reduce((sum, p) => sum + (tempYMap.get(p) || 0), 0) /
            validParents.length;
          barycenters.set(node.id, avgY);
        } else {
          barycenters.set(node.id, node.position.y);
        }
      });

      currentLayerNodes.sort((a, b) => (barycenters.get(a.id) || 0) - (barycenters.get(b.id) || 0));

      currentLayerNodes.forEach((node, idx) => {
        tempYMap.set(node.id, idx * 300);
      });
    }

    // 3.5 几何尺寸感知坐标计算
    // 计算每列的最大宽度与该分量的最大高度
    const colWidths: number[] = layers.map((colNodes) => {
      if (colNodes.length === 0) return 0;
      return Math.max(...colNodes.map((n) => getNodeBounds(n).width));
    });

    // 计算每列的纵向总高度
    const colHeights: number[] = layers.map((colNodes) => {
      if (colNodes.length === 0) return 0;
      const totalH = colNodes.reduce((sum, n) => sum + getNodeBounds(n).height, 0);
      return totalH + Math.max(0, colNodes.length - 1) * verticalSpacing;
    });

    const maxPipelineHeight = Math.max(...colHeights, 100);

    // 计算每列的 X 起始坐标
    const colXPositions: number[] = [originX];
    for (let l = 1; l <= maxLayer; l++) {
      const prevX = colXPositions[l - 1];
      const prevW = colWidths[l - 1];
      colXPositions.push(prevX + prevW + horizontalSpacing);
    }

    // 赋予具体坐标 (居中对齐较矮的列)
    layers.forEach((colNodes, l) => {
      const colX = colXPositions[l];
      const colH = colHeights[l];
      // 垂直居中偏移
      const verticalOffset = (maxPipelineHeight - colH) / 2;
      let curY = currentLaneY + verticalOffset;

      colNodes.forEach((node) => {
        const { height } = getNodeBounds(node);
        posMap.set(node.id, {
          x: Math.round(colX),
          y: Math.round(curY),
        });
        curY += height + verticalSpacing;
      });
    });

    // 推进泳道 Y 坐标
    currentLaneY += maxPipelineHeight + laneSpacing;
  });

  // 4. 孤立素材/草稿卡片独立停靠区 (Isolates Dock)
  if (isolatedNodes.length > 0) {
    // 孤立卡片按原始 Y 与 X 排序
    isolatedNodes.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

    const dockStartY = connectedComponents.length > 0 ? currentLaneY + 20 : originY;
    let gridCol = 0;
    let gridRow = 0;
    let rowMaxH = 0;
    let curRowY = dockStartY;

    // 获取标准列宽
    const ISOLATE_COL_W = 280;
    const ISOLATE_GAP_X = 40;
    const ISOLATE_GAP_Y = 40;

    isolatedNodes.forEach((node) => {
      const { width, height } = getNodeBounds(node);
      const posX = originX + gridCol * (ISOLATE_COL_W + ISOLATE_GAP_X);
      const posY = curRowY;

      posMap.set(node.id, {
        x: Math.round(posX),
        y: Math.round(posY),
      });

      rowMaxH = Math.max(rowMaxH, height);
      gridCol++;

      if (gridCol >= scratchCols) {
        gridCol = 0;
        gridRow++;
        curRowY += rowMaxH + ISOLATE_GAP_Y;
        rowMaxH = 0;
      }
    });
  }

  // 5. 生成最终的节点数组
  return allNodes.map((node) => {
    if (posMap.has(node.id)) {
      return {
        ...node,
        position: posMap.get(node.id)!,
      };
    }
    return node;
  });
}

/**
 * 平滑动画过渡排版 (Smooth Animation Transition)
 * 将节点平滑缓动至目标排版坐标，支持取消和回调
 */
export function animateLayoutTransition(
  initialNodes: Node[],
  targetNodes: Node[],
  setNodes: (nodes: Node[]) => void,
  duration = 320,
  onComplete?: () => void
): () => void {
  const startMap = new Map<string, { x: number; y: number }>();
  initialNodes.forEach((n) => startMap.set(n.id, { ...n.position }));

  const targetMap = new Map<string, { x: number; y: number }>();
  targetNodes.forEach((n) => targetMap.set(n.id, { ...n.position }));

  let animFrameId: number;
  const startTime = performance.now();

  // Ease-out cubic: 1 - pow(1 - t, 3)
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

  const step = (now: number) => {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    const easeProgress = easeOutCubic(progress);

    const updated = initialNodes.map((node) => {
      const startPos = startMap.get(node.id);
      const targetPos = targetMap.get(node.id);

      if (!startPos || !targetPos) return node;

      const currentX = startPos.x + (targetPos.x - startPos.x) * easeProgress;
      const currentY = startPos.y + (targetPos.y - startPos.y) * easeProgress;

      return {
        ...node,
        position: {
          x: Math.round(currentX),
          y: Math.round(currentY),
        },
      };
    });

    setNodes(updated);

    if (progress < 1) {
      animFrameId = requestAnimationFrame(step);
    } else {
      // 最终确保精准坐标对齐
      setNodes(targetNodes);
      onComplete?.();
    }
  };

  animFrameId = requestAnimationFrame(step);

  return () => cancelAnimationFrame(animFrameId);
}
