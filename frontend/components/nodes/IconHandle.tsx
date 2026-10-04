'use client';

import React, { useContext } from 'react';
import { Handle, Position, HandleProps } from '@xyflow/react';
import { useT } from '@/lib/i18n';
import { InNodeShell } from './NodeShell';

export type PortType = 'prompt' | 'image' | 'character' | 'video' | 'pose' | 'gaussian' | 'audio';

interface IconHandleProps extends Omit<HandleProps, 'type' | 'position'> {
  portType: PortType;
  type: 'source' | 'target';
  position?: Position;
  nodeId: string;
  title?: string;
  icon?: 'firstFrame';
}

const PORT_CONFIG: Record<PortType, { label: string; short: string; symbol: string }> = {
  prompt: {
    label: '提示词 (Prompt)',
    short: '提示词',
    symbol: 'T',
  },
  image: {
    label: '图像 (Image)',
    short: '图像',
    symbol: '🖼',
  },
  video: {
    label: '视频 (Video)',
    short: '视频',
    symbol: '▶',
  },
  character: {
    label: '角色参考 (Character)',
    short: '角色',
    symbol: '👤',
  },
  pose: {
    label: '3D姿态 (Pose)',
    short: '姿态',
    symbol: '🧍',
  },
  gaussian: {
    label: '高斯点云 (3DGS)',
    short: '高斯',
    symbol: '◈',
  },
  audio: {
    label: '声音参考 (Audio)',
    short: '声音',
    symbol: '🎵',
  },
};

const PORT_COLORS: Record<PortType, { border: string; glow: string; text: string }> = {
  prompt: { border: 'rgba(168, 85, 247, 0.5)', glow: 'rgba(168, 85, 247, 0.35)', text: '#c084fc' },
  image: { border: 'rgba(16, 185, 129, 0.5)', glow: 'rgba(16, 185, 129, 0.35)', text: '#34d399' },
  video: { border: 'rgba(6, 182, 212, 0.5)', glow: 'rgba(6, 182, 212, 0.35)', text: '#22d3ee' },
  character: { border: 'rgba(244, 63, 94, 0.5)', glow: 'rgba(244, 63, 94, 0.35)', text: '#fb7185' },
  pose: { border: 'rgba(99, 102, 241, 0.5)', glow: 'rgba(99, 102, 241, 0.35)', text: '#818cf8' },
  gaussian: { border: 'rgba(20, 184, 166, 0.5)', glow: 'rgba(20, 184, 166, 0.35)', text: '#2dd4bf' },
  audio: { border: 'rgba(251, 113, 133, 0.5)', glow: 'rgba(251, 113, 133, 0.35)', text: '#fda4af' },
};

export default function IconHandle({ portType, type, position, nodeId, style, title, icon, id, ...rest }: IconHandleProps) {
  const t = useT();
  // Inside a node shell the shell spaces the handles evenly; a top given here would fight it.
  const inShell = useContext(InNodeShell);
  const { top: _top, ...placement } = (style || {}) as React.CSSProperties;
  const pos = position || (type === 'source' ? Position.Right : Position.Left);
  const cfg = PORT_CONFIG[portType] || PORT_CONFIG.prompt;
  const col = PORT_COLORS[portType] || PORT_COLORS.prompt;
  const isTarget = type === 'target';
  const handleId = id || (type === 'source' ? `out-${portType}` : `in-${portType}`);

  const triggerPortMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('openPortMenu', {
      detail: {
        clientX: e.clientX,
        clientY: e.clientY,
        portType,
        nodeId,
        handleType: type,
        handleId,
      }
    }));
  };

  const offset = pos === Position.Left ? { left: -10 } : pos === Position.Right ? { right: -10 } : {};

  return (
    <Handle
      id={handleId}
      type={type}
      position={pos}
      onClick={triggerPortMenu}
      onDoubleClick={triggerPortMenu}
      className="nodrag react-flow__handle group"
      title={title || `${isTarget ? t('输入') : t('输出')}: ${t(cfg.label)}`}
      style={{
        width: 22,
        height: 22,
        background: '#0e0e14',
        border: `1.5px solid ${col.border}`,
        borderRadius: '50%',
        boxShadow: `0 2px 10px rgba(0, 0, 0, 0.8), inset 0 0 6px ${col.glow}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        cursor: 'crosshair',
        transition: 'all 0.15s ease',
        ...offset,
        ...(inShell ? placement : style),
      }}
      data-porttype={portType}
      {...rest}
    >
      {/* Precision Vector Icon inside socket */}
      <div 
        className="w-full h-full flex items-center justify-center pointer-events-none transition-colors duration-150"
        style={{ color: col.text }}
      >
        <PortIcon portType={portType} icon={icon} />
      </div>
    </Handle>
  );
}

function PortIcon({ portType, icon }: { portType: PortType; icon?: 'firstFrame' }) {
  if (icon === 'firstFrame') {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M8 8v8M12 8l5 4-5 4z" fill="currentColor" fillOpacity="0.2" />
      </svg>
    );
  }
  switch (portType) {
    case 'prompt':
      return <span className="font-mono text-[10px] font-bold text-zinc-300 group-hover:text-white leading-none">T</span>;
    case 'image':
      return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      );
    case 'video':
      return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" fillOpacity="0.2" />
        </svg>
      );
    case 'character':
      return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M6 20v-2a6 6 0 0 1 12 0v2" />
        </svg>
      );
    case 'pose':
      return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="4" r="2" />
          <path d="M12 6v7M8 9l4 2 4-2M9 19l3-6 3 6" />
        </svg>
      );
    case 'gaussian':
      return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      );
    default:
      return <div className="w-1.5 h-1.5 rounded-full bg-zinc-300 group-hover:bg-white" />;
  }
}
