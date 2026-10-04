'use client';

import React, { useMemo } from 'react';
import { useViewport, useReactFlow, getBezierPath, Position } from '@xyflow/react';

export interface PortMenuData {
  x: number;
  y: number;
  cx: number;
  cy: number;
  portType: string;
  nodeId: string;
  handleType: 'source' | 'target';
  handleId: string | null;
}

interface TemporaryConnectionLineProps {
  portMenu: PortMenuData | null;
}

export default function TemporaryConnectionLine({ portMenu }: TemporaryConnectionLineProps) {
  const { x, y, zoom } = useViewport();
  const { getNode, screenToFlowPosition } = useReactFlow();

  const handleInfo = useMemo(() => {
    if (!portMenu) return null;

    let handleEl: Element | null = null;
    if (portMenu.handleId) {
      handleEl =
        document.querySelector(`.react-flow__node[data-id="${portMenu.nodeId}"] .react-flow__handle[data-handleid="${portMenu.handleId}"]`) ||
        document.querySelector(`.react-flow__node[data-id="${portMenu.nodeId}"] #${portMenu.handleId}`);
    }
    if (!handleEl && portMenu.portType) {
      handleEl =
        document.querySelector(`.react-flow__node[data-id="${portMenu.nodeId}"] .react-flow__handle[data-porttype="${portMenu.portType}"][data-handlepos]`) ||
        document.querySelector(`.react-flow__node[data-id="${portMenu.nodeId}"] .react-flow__handle[data-porttype="${portMenu.portType}"]`);
    }
    if (!handleEl) {
      handleEl =
        document.querySelector(`.react-flow__node[data-id="${portMenu.nodeId}"] .react-flow__handle.${portMenu.handleType}`) ||
        document.querySelector(`.react-flow__node[data-id="${portMenu.nodeId}"] .react-flow__handle`);
    }

    let handlePos = Position.Right;
    if (handleEl) {
      const posAttr = handleEl.getAttribute('data-handlepos') as Position | null;
      if (posAttr) {
        handlePos = posAttr;
      } else if (handleEl.classList.contains('react-flow__handle-left')) {
        handlePos = Position.Left;
      } else if (handleEl.classList.contains('react-flow__handle-right')) {
        handlePos = Position.Right;
      } else if (handleEl.classList.contains('react-flow__handle-top')) {
        handlePos = Position.Top;
      } else if (handleEl.classList.contains('react-flow__handle-bottom')) {
        handlePos = Position.Bottom;
      } else {
        handlePos = portMenu.handleType === 'source' ? Position.Right : Position.Left;
      }

      const rect = handleEl.getBoundingClientRect();
      const flowPos = screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });

      return {
        x: flowPos.x,
        y: flowPos.y,
        position: handlePos,
      };
    }

    // Fallback if handle DOM element is not yet found
    const node = getNode(portMenu.nodeId);
    if (node) {
      const w = (node as any).measured?.width || (node.style?.width as number) || node.width || 300;
      const h = (node as any).measured?.height || (node.style?.height as number) || node.height || 200;
      if (portMenu.handleType === 'source') {
        return {
          x: node.position.x + w,
          y: node.position.y + h / 2,
          position: Position.Right,
        };
      } else {
        return {
          x: node.position.x,
          y: node.position.y + h / 2,
          position: Position.Left,
        };
      }
    }

    return null;
  }, [portMenu, getNode, screenToFlowPosition]);

  if (!portMenu || !handleInfo) return null;

  const isSource = portMenu.handleType === 'source';

  const sourceX = isSource ? handleInfo.x : portMenu.cx;
  const sourceY = isSource ? handleInfo.y : portMenu.cy;
  const targetX = isSource ? portMenu.cx : handleInfo.x;
  const targetY = isSource ? portMenu.cy : handleInfo.y;

  const sourcePosition = isSource
    ? handleInfo.position
    : portMenu.cx < handleInfo.x
    ? Position.Right
    : Position.Left;

  const targetPosition = isSource
    ? portMenu.cx < handleInfo.x
      ? Position.Right
      : Position.Left
    : handleInfo.position;

  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <svg
      style={{
        position: 'absolute',
        width: '100%',
        height: '100%',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 15,
        overflow: 'visible',
      }}
    >
      <defs>
        <linearGradient id="tempConnectionGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#d4d4d8" stopOpacity="0.7" />
        </linearGradient>
        <filter id="tempConnectionGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g transform={`translate(${x}, ${y}) scale(${zoom})`}>
        {/* Soft background glow line */}
        <path
          d={path}
          fill="none"
          stroke="rgba(255, 255, 255, 0.15)"
          strokeWidth={5}
          strokeLinecap="round"
        />
        {/* Animated active connection line */}
        <path
          d={path}
          fill="none"
          stroke="url(#tempConnectionGradient)"
          strokeWidth={2}
          strokeDasharray="6 4"
          className="temp-connection-line-dash"
          strokeLinecap="round"
          filter="url(#tempConnectionGlow)"
        />
        {/* Target end anchor point */}
        <circle
          cx={portMenu.cx}
          cy={portMenu.cy}
          r={4}
          fill="#ffffff"
          stroke="rgba(0,0,0,0.8)"
          strokeWidth={1.5}
        />
      </g>
    </svg>
  );
}
