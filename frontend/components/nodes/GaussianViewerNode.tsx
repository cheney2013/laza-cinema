'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { NodeProps, useReactFlow, useConnection } from '@xyflow/react';
import type { GaussianViewerNode as GaussianViewerNodeType } from '@/lib/types';
import { api } from '@/lib/api';
import { BACKEND_URL } from '@/lib/config';
import IconHandle from './IconHandle';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { t } from '@/lib/i18n';

/**
 * Looks at a PLY that already exists: one opened or dropped here, or the model a
 * connected 高斯模型 node produced. Unlike that node it generates nothing. A plain
 * point cloud (GAE, DA3, a scan) is shown as small round splats; the viewer page
 * converts it. The screenshot is this node's image output.
 */
function GaussianViewerNode({ id, data, selected }: NodeProps<GaussianViewerNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connection = useConnection();
  const connected = useConnectedInputs(id);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const iframeReadyRef = useRef(false);
  const [isHovered, setIsHovered] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // While a file is dragged anywhere on the page the viewer iframe stops taking
  // pointer events; otherwise a drop onto a loaded node lands in the iframe's
  // own document and never reaches this node.
  const [fileDragging, setFileDragging] = useState(false);
  useEffect(() => {
    const start = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) setFileDragging(true); };
    const stop = () => { setFileDragging(false); setDragOver(false); };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) stop(); };
    window.addEventListener('dragenter', start);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', stop);
    window.addEventListener('dragend', stop);
    return () => {
      window.removeEventListener('dragenter', start);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', stop);
      window.removeEventListener('dragend', stop);
    };
  }, []);
  const [scale, setScale] = useState(1);

  // A connected gaussian node's model wins over a file opened here.
  const upstream = connected.find((n) => (n as any).plyUrl) as { plyUrl?: string; plyOriginalName?: string } | undefined;
  const plyUrl = (upstream?.plyUrl || data.plyUrl) as string | null;
  const plyName = upstream ? upstream.plyOriginalName : data.plyOriginalName;
  const busy = data.status === 'loading' || data.status === 'capturing';

  // Load the viewer only when asked (a canvas with several of these nodes would load them all at once). A file opened
  // or connected while the node is open is shown right away.
  const [viewerActive, setViewerActive] = useState(false);
  const plyBefore = useRef<string | null | undefined>(plyUrl);
  useEffect(() => {
    if (plyUrl && plyUrl !== plyBefore.current) setViewerActive(true);
    plyBefore.current = plyUrl;
  }, [plyUrl]);

  const sendLoad = useCallback(() => {
    if (iframeRef.current?.contentWindow && plyUrl) {
      updateNodeData(id, { status: 'loading', error: undefined });
      iframeRef.current.contentWindow.postMessage({ type: 'LOAD_PLY_URL', url: `${BACKEND_URL}${plyUrl}` }, '*');
    }
  }, [id, plyUrl, updateNodeData]);

  useEffect(() => {
    if (plyUrl && iframeReadyRef.current) sendLoad();
    if (!plyUrl) iframeReadyRef.current = false;
  }, [plyUrl, sendLoad]);

  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const msg = e.data;
      if (!msg?.type) return;
      if (msg.type === 'MESH_LOADED') {
        updateNodeData(id, { status: 'ready', error: undefined });
      } else if (msg.type === 'MESH_ERROR') {
        updateNodeData(id, { status: 'error', error: msg.error || t('加载失败') });
      } else if (msg.type === 'CAPTURE_RESULT' && msg.image) {
        try {
          const name = (plyUrl || 'scene').split('/').pop() || 'scene';
          const result = await api.captureGaussian(msg.image, name);
          updateNodeData(id, { status: 'ready', generatedUrl: result.url, error: undefined });
        } catch (err: any) {
          updateNodeData(id, { status: 'error', error: err.message });
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [id, plyUrl, updateNodeData]);

  const openFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.ply')) {
      updateNodeData(id, { status: 'error', error: t('只支持 .ply 文件') });
      return;
    }
    updateNodeData(id, { status: 'loading', error: undefined });
    try {
      const r = await api.uploadPly(file);
      updateNodeData(id, { plyUrl: r.url, plyFilename: r.filename, plyOriginalName: r.original_name });
    } catch (err: any) {
      updateNodeData(id, { status: 'error', error: err.message });
    }
  }, [id, updateNodeData]);

  const capture = useCallback(() => {
    if (!iframeRef.current || busy || !plyUrl) return;
    updateNodeData(id, { status: 'capturing', error: undefined });
    iframeRef.current.contentWindow?.postMessage({ type: 'CAPTURE' }, '*');
  }, [id, busy, plyUrl, updateNodeData]);

  const sizing = useNodeSizing({
    id,
    type: 'gaussianViewer',
    rows: ['header'],
    paddingX: 0,
    ratioSources: [{ width: data.width as number | undefined, height: data.height as number | undefined }],
    userWidth: data.userWidth,
  });
  const showOverlay = isHovered || selected;

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} shellRef={sizing.shellRef}>
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <ViewerIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('高斯查看')}</span>
        </div>
        {plyName && (
          <span title={plyName} style={{ fontSize: 9, color: '#888', background: 'rgba(255,255,255,0.05)', padding: '1px 6px', borderRadius: 8, marginLeft: 4, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {plyName}
          </span>
        )}
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          style={{ ...cardBody, width: '100%', height: '100%', overflow: 'visible', display: 'flex', flexDirection: 'column', background: 'transparent' }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setDragOver(true); } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault(); e.stopPropagation(); setDragOver(false);
            openFile(e.dataTransfer.files[0]);
          }}
        >
          <div className="nodrag" style={{ position: 'relative', flex: 1, borderRadius: 20, overflow: 'hidden', boxShadow: selected ? selectedShadow : defaultShadow, background: 'rgba(0,0,0,0.2)', outline: dragOver ? '2px dashed rgba(122,180,255,0.8)' : 'none' }}>
            {plyUrl && viewerActive ? (
              <iframe
                ref={iframeRef}
                src={`${BACKEND_URL}/gaussian/viewer?hide_controls=true`}
                onLoad={() => { iframeReadyRef.current = true; sendLoad(); }}
                title="Gaussian Viewer"
                style={{ width: '100%', height: '100%', border: 'none', display: 'block', pointerEvents: connection.inProgress || fileDragging ? 'none' : 'auto' }}
                allow="cross-origin-isolated; fullscreen"
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            ) : plyUrl ? (
              <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20 }}>
                <div className="w-10 h-10 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-zinc-500">
                  <ViewerIcon />
                </div>
                <div style={{ fontSize: 12, color: '#a1a1aa', textAlign: 'center', lineHeight: 1.5, wordBreak: 'break-all' }}>
                  {(plyName as string) || t('高斯模型')}
                </div>
                <button
                  onClick={() => setViewerActive(true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/20 text-white border border-white/15 cursor-pointer"
                  title={t('点击后才加载查看器，打开画布时不会自动加载')}
                >
                  {t('点击加载')}
                </button>
              </div>
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20 }}>
                <div className="w-10 h-10 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-zinc-500">
                  <ViewerIcon />
                </div>
                <div style={{ fontSize: 12, color: '#71717a', textAlign: 'center', lineHeight: 1.5 }}>
                  {t('拖入 .ply（高斯或点云），或连接高斯模型节点')}
                </div>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/20 text-white border border-white/15 cursor-pointer"
                >
                  {t('打开 PLY')}
                </button>
              </div>
            )}
            <input ref={fileRef} type="file" accept=".ply" hidden onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = ''; }} />

            {busy && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, fontSize: 12, color: '#aaa', pointerEvents: 'none' }}>
                {data.status === 'capturing' ? t('正在截图中...') : t('正在加载模型...')}
              </div>
            )}

            {plyUrl && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, padding: '14px 10px 8px',
                background: 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%)',
                display: 'flex', alignItems: 'center', gap: 6,
                opacity: showOverlay ? 1 : 0, transition: 'opacity 0.2s', pointerEvents: showOverlay ? 'auto' : 'none', zIndex: 20,
              }}>
                <button className="nodrag" onClick={() => iframeRef.current?.contentWindow?.postMessage({ type: 'RESET_CAMERA' }, '*')} title={t('重置相机视角')} style={iconBtn}>
                  <ResetIcon />
                </button>
                {!upstream && (
                  <button className="nodrag" onClick={() => fileRef.current?.click()} title={t('换一个 PLY')} style={iconBtn}>
                    <FolderIcon />
                  </button>
                )}
                <div className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#aaa', fontSize: 11, flex: 1 }}>
                  <span>{t('大小')}</span>
                  <input
                    type="range" min="0.05" max="4" step="0.05" value={scale}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setScale(v);
                      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_SCALE', scale: v }, '*');
                    }}
                    style={{ flex: 1, minWidth: 0, cursor: 'pointer', accentColor: '#7ab4ff' }}
                  />
                </div>
                <button className="nodrag" onClick={capture} disabled={busy} title={t('把当前视角截图作为输出图')} style={{ ...iconBtn, color: '#7ab4ff' }}>
                  <CameraIcon />
                </button>
              </div>
            )}

            {data.generatedUrl && (
              <div style={{ position: 'absolute', top: 8, left: 8, width: 64, height: 48, borderRadius: 5, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.3)', zIndex: 20, opacity: showOverlay ? 1 : 0.7 }}>
                <img src={`${BACKEND_URL}${data.generatedUrl}`} alt="capture" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            )}

            {data.status === 'error' && data.error && (
              <div style={{ position: 'absolute', top: 12, left: 12, right: 12, zIndex: 40, padding: '6px 10px', fontSize: 11, textAlign: 'center', color: '#f87171', background: 'rgba(20,10,12,0.92)', borderRadius: 8, border: '1px solid rgba(248,113,113,0.3)', pointerEvents: 'none' }}>
                {data.error}
              </div>
            )}
          </div>

          <IconHandle type="target" id="in-gaussian" portType="gaussian" nodeId={id} style={{ top: '50%' }} />
          <IconHandle type="source" portType="image" nodeId={id} />
        </div>
      </div>
    </NodeShell>
  );
}

export default memo(GaussianViewerNode);

const iconBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)',
  color: 'rgba(255,255,255,0.7)', borderRadius: 7, padding: '4px 6px', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

function ViewerIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.8" strokeLinecap="round">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
