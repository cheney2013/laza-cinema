'use client';

import { useEffect, memo, useRef } from 'react';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { t } from '@/lib/i18n';

function PreviewImageNode({ id, data, selected }: NodeProps) {
  const { updateNodeData, getNode } = useReactFlow();
  const connected = useConnectedInputs(id);
  const connectedImageNode = connected.find((n) => n.type === 'image' || n.type === 'gaussian' || n.type === 'preview');
  const imageUrl = connectedImageNode ? (connectedImageNode.generatedUrl || connectedImageNode.url) : null;
  const currentShadow = selected ? selectedShadow : defaultShadow;

  const sizing = useAutoHeightNode({
    id,
    ratioSources: [
      { width: data.width as number | undefined, height: data.height as number | undefined },
    ],
    userWidth: data.userWidth as number | undefined,
    defaultW: 320,
  });

  // 图片的自然尺寸写进 data，既是比例来源也是下游节点的分辨率依据
  useEffect(() => {
    const w = connectedImageNode?.width;
    const h = connectedImageNode?.height;
    if (!w || !h) return;
    sizing.onMediaSize(w, h);
    if (data.width !== w || data.height !== h) updateNodeData(id, { width: w, height: h });
  }, [connectedImageNode?.width, connectedImageNode?.height, data.width, data.height, id, updateNodeData, sizing.onMediaSize]);

  // 沿用原行为：预览节点跟随上游节点的显示宽度，方便并排比对。
  // 只在还没有用户手动宽度时采纳一次 —— 用户拖过之后宽度就归用户。
  const adoptedFromRef = useRef<string | null>(null);
  useEffect(() => {
    const srcId = connectedImageNode?.id;
    if (!srcId || data.userWidth || adoptedFromRef.current === srcId) return;
    const srcWidth = getNode(srcId)?.width;
    if (!srcWidth) return;
    adoptedFromRef.current = srcId;
    updateNodeData(id, { userWidth: srcWidth });
  }, [connectedImageNode?.id, data.userWidth, getNode, id, updateNodeData]);

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      autoHeight
    >
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <PreviewIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('大图预览')}</span>
        </div>
      </div>

      <div style={{ position: 'relative', flex: '0 0 auto', aspectRatio: String(sizing.ratio) }}>
        <div style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'transparent' }}>
          <div className="node-shell-media" style={{ position: 'relative', borderRadius: 20, boxShadow: currentShadow, background: 'rgba(0,0,0,0.2)' }}>
            {imageUrl ? (
              <img
                src={(imageUrl.startsWith('blob:') || imageUrl.startsWith('http') ? imageUrl : `${API_BASE}${imageUrl}`) || undefined}
                alt=""
                decoding="async"
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (!img.naturalWidth || !img.naturalHeight) return;
                  sizing.onMediaSize(img.naturalWidth, img.naturalHeight);
                  if (data.width !== img.naturalWidth || data.height !== img.naturalHeight) {
                    updateNodeData(id, { width: img.naturalWidth, height: img.naturalHeight });
                  }
                }}
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
              />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 13, width: '100%', height: '100%' }}>
                
                {t('等待输入...')}
              </div>
            )}
          </div>
        </div>
        <IconHandle type="target" id="in-image" portType="image" nodeId={id} style={{ top: '50%' }} />
        <IconHandle type="source" portType="image" nodeId={id} />
      </div>
    </NodeShell>
  );
}

export default memo(PreviewImageNode);

function PreviewIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
