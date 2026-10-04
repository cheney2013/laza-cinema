'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { NodeProps, useReactFlow, useConnection } from '@xyflow/react';
import { PoseNode as PoseNodeType } from '@/lib/types';
import { api } from '@/lib/api';
import { BACKEND_URL } from '@/lib/config';
import { useStore } from '@/lib/store';
import IconHandle from './IconHandle';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { t } from '@/lib/i18n';

function PoseNode({ id, data, selected }: NodeProps<PoseNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connection = useConnection();
  const isConnecting = connection.inProgress;

  const connected = useConnectedInputs(id);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isHovered, setIsHovered] = useState(false);


  const isSaving = data.status === 'saving';

  const currentShadow   = selected ? selectedShadow : defaultShadow;
  const iframeReadyRef  = useRef(false);

  // Input image connected
  const connectedImageNode = connected.find((n) => n.type === 'image' || n.type === 'upload');
  const targetImageUrl     = connectedImageNode ? (connectedImageNode.generatedUrl || connectedImageNode.url) : null;

  // Sync dimensions
  const connectedNodeId = connectedImageNode?.id;
  const connectedLayoutStr = useStore((state) => {
    if (!connectedNodeId) return null;
    const n = state.nodes.find((x) => x.id === connectedNodeId);
    if (!n) return null;
    const w = n.style?.width as number || n.width || n.measured?.width;
    const h = n.style?.height as number || n.height || n.measured?.height;
    return JSON.stringify({ width: w, height: h });
  });
  const connectedLayout = connectedLayoutStr ? JSON.parse(connectedLayoutStr) : null;

  const sizing = useNodeSizing({
    id,
    type: 'pose',
    rows: ['header'],
    paddingX: 0,
    // 姿态视图跟着输入图的画幅走，没有输入时用连入节点的显示比例兜底
    ratioSources: [
      { width: connectedImageNode?.width, height: connectedImageNode?.height },
      { width: connectedLayout?.width, height: connectedLayout?.height },
    ],
    userWidth: (data.userWidth as number | undefined) ?? connectedLayout?.width,
  });

  // 原来这里往 n.style.width/height 写同步。ReactFlow v12 里 ResizeObserver 一旦写过
  // node.width，style.width 就被忽略，所以那份同步实际上早就不生效了。
  // 现在改成：比例走上面的 ratioSources，宽度跟随连入节点（用户拖过后归用户）。

  // ── Send mode + background to iframe ─────────────────────────────────────────
  const sendInitMode = useCallback(() => {
    if (!iframeRef.current?.contentWindow) return;
    const bgUrl = targetImageUrl
      ? (targetImageUrl.startsWith('http') ? targetImageUrl : `${BACKEND_URL}${targetImageUrl}`)
      : undefined;
    iframeRef.current.contentWindow.postMessage({ type: 'INIT_MODE', mode: 'openpose', bgUrl }, '*');
  }, [targetImageUrl]);

  // ── Restore saved edited openpose JSON into viewer ────────────────────────────
  const sendLoadOpenPoseJson = useCallback((poseJsonUrl: string) => {
    const bgUrl = targetImageUrl
      ? (targetImageUrl.startsWith('http') ? targetImageUrl : `${BACKEND_URL}${targetImageUrl}`)
      : undefined;
    fetch(`${BACKEND_URL}${poseJsonUrl}`)
      .then(r => r.json())
      .then(jsonData => {
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'LOAD_OPENPOSE_JSON', data: jsonData, bgUrl },
          '*'
        );
      })
      .catch(() => sendInitMode());
  }, [targetImageUrl, sendInitMode]);

  // ── Load OpenPose from extracted GLB ──────────────────────────────────────────
  const sendLoadOpenPoseFromScail = useCallback(() => {
    const targetUrl = data.glbUrl;
    if (!iframeRef.current?.contentWindow || !targetUrl || targetUrl === 'default') return;
    const bgUrl = targetImageUrl
      ? (targetImageUrl.startsWith('http') ? targetImageUrl : `${BACKEND_URL}${targetImageUrl}`)
      : undefined;
    iframeRef.current.contentWindow.postMessage(
      { type: 'LOAD_OPENPOSE_FROM_SCAIL', url: `${BACKEND_URL}${targetUrl}`, bgUrl },
      '*'
    );
  }, [data.glbUrl, targetImageUrl]);

  // ── Listen to iframe messages ─────────────────────────────────────────────────
  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const msg = e.data;
      if (!msg?.type) return;

      if (msg.type === 'VIEWER_READY') {
        iframeReadyRef.current = true;
        if (data.wholebodyJsonUrl) {
          // Wholebody mode: re-fetch JSON and send to viewer
          fetch(`${BACKEND_URL}${data.wholebodyJsonUrl}`)
            .then(r => r.json())
            .then(jsonData => {
              const bgUrl = targetImageUrl
                ? (targetImageUrl.startsWith('http') ? targetImageUrl : `${BACKEND_URL}${targetImageUrl}`)
                : undefined;
              iframeRef.current?.contentWindow?.postMessage(
                { type: 'LOAD_WHOLEBODY_JSON', data: jsonData, bgUrl },
                '*'
              );
            })
            .catch(() => sendInitMode());
        } else if (data.poseJsonUrl) {
          // Restore previously saved edited openpose skeleton
          sendLoadOpenPoseJson(data.poseJsonUrl);
        } else if (data.glbUrl && data.glbUrl !== 'default') {
          sendLoadOpenPoseFromScail();
        } else {
          sendInitMode();
        }
      } else if (msg.type === 'MODEL_LOADED') {
        updateNodeData(id, { status: 'ready', error: undefined });
      } else if (msg.type === 'MODEL_ERROR') {
        updateNodeData(id, { status: 'error', error: msg.error || 'Load failed' });
      } else if (msg.type === 'GLB_EXPORTED') {
        if (!msg.data) return;
        try {
          updateNodeData(id, { status: 'saving' });

          const blob = new Blob([msg.data], { type: 'application/json' });
          const file = new File([blob], 'openpose.json', { type: 'application/json' });
          const formData = new FormData();
          formData.append('file', file);
          const res = await fetch(`${BACKEND_URL}/upload-glb`, { method: 'POST', body: formData });
          const result = await res.json();

          let poseImgUrl: string | undefined;
          if (msg.dataUrl) {
            try {
              const imgRes = await api.uploadImageBase64(msg.dataUrl);
              poseImgUrl = imgRes.url;
            } catch (err) { console.error('Failed to upload pose snapshot:', err); }
          }

          let depthImgUrl: string | undefined;
          if (msg.depthDataUrl) {
            try {
              const depthRes = await api.uploadImageBase64(msg.depthDataUrl);
              depthImgUrl = depthRes.url;
            } catch (err) { console.error('Failed to upload depth map:', err); }
          }

          updateNodeData(id, {
            status: 'done',
            generatedUrl: result.url,
            poseJsonUrl: result.url,   // persists edited skeleton across page reloads
            poseImageUrl: poseImgUrl,
            depthImageUrl: depthImgUrl,
          });
          window.dispatchEvent(new Event('takeSnapshot'));
        } catch (err: any) {
          updateNodeData(id, { status: 'error', error: err.message });
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [id, updateNodeData, sendLoadOpenPoseFromScail, sendLoadOpenPoseJson, sendInitMode, data.glbUrl, data.poseJsonUrl]);

  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    if (data.poseJsonUrl) {
      sendLoadOpenPoseJson(data.poseJsonUrl);
    } else if (data.glbUrl && data.glbUrl !== 'default') {
      sendLoadOpenPoseFromScail();
    } else {
      sendInitMode();
    }
  }, [data.poseJsonUrl, data.glbUrl, sendLoadOpenPoseJson, sendLoadOpenPoseFromScail, sendInitMode]);

  // When GLB URL changes: load into viewer
  useEffect(() => {
    if (!data.glbUrl || data.glbUrl === 'default' || !iframeReadyRef.current) return;
    sendLoadOpenPoseFromScail();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.glbUrl]);

  // Extract pose via ComfyUI (NLF 3D skeleton)
  const handleExtractPose = useCallback(async () => {
    if (!targetImageUrl) return;
    updateNodeData(id, { status: 'loading', error: undefined, glbUrl: null, generatedUrl: null });
    try {
      const res = await api.extractPose(targetImageUrl);
      updateNodeData(id, { status: 'ready', glbUrl: res.url, sourceImageUrl: targetImageUrl, poseImageUrl: undefined });
    } catch (err: any) {
      updateNodeData(id, { status: 'error', error: err.message });
    }
  }, [id, targetImageUrl, updateNodeData]);



  // Extract full-body 3D joints (body + hands + face) via MediaPipe → load into 3D viewer
  const handleExtractWholebody3D = useCallback(async () => {
    if (!targetImageUrl) return;
    updateNodeData(id, { status: 'loading', error: undefined, wholebodyJsonUrl: null });
    try {
      const res = await api.extractWholebody3D(targetImageUrl);
      updateNodeData(id, { status: 'ready', wholebodyJsonUrl: res.url, sourceImageUrl: targetImageUrl, glbUrl: null });
      // Fetch the JSON and send to iframe viewer
      const jsonRes = await fetch(`${BACKEND_URL}${res.url}`);
      const data = await jsonRes.json();
      const bgUrl = targetImageUrl
        ? (targetImageUrl.startsWith('http') ? targetImageUrl : `${BACKEND_URL}${targetImageUrl}`)
        : undefined;
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'LOAD_WHOLEBODY_JSON', data, bgUrl },
        '*'
      );
    } catch (err: any) {
      updateNodeData(id, { status: 'error', error: err.message || t('全身 3D 提取失败') });
    }
  }, [id, targetImageUrl, updateNodeData]);

  const handleSave = useCallback(() => {
    if (!iframeRef.current) return;
    updateNodeData(id, { status: 'saving', error: undefined });
    iframeRef.current.contentWindow?.postMessage({ type: 'EXPORT_GLB' }, '*');
  }, [id, updateNodeData]);

  const handleResetCamera = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'RESET_CAMERA' }, '*');
  }, []);

  useEffect(() => {
    if (data.glbUrl && data.glbUrl !== 'default' && !data.sourceImageUrl && targetImageUrl)
      updateNodeData(id, { sourceImageUrl: targetImageUrl });
  }, [data.glbUrl, data.sourceImageUrl, targetImageUrl, id, updateNodeData]);

  const isOutdated = !!(data.glbUrl && data.glbUrl !== 'default' && targetImageUrl && data.sourceImageUrl && targetImageUrl !== data.sourceImageUrl);

  const viewerCacheBustRef = useRef(Date.now());
  const viewerUrl = `${BACKEND_URL}/pose/viewer?v=${viewerCacheBustRef.current}`;
  const showOverlay = isHovered || selected;

  const showExtractPrompt = !!targetImageUrl && !data.glbUrl;

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      shellRef={sizing.shellRef}
    >
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <PoseIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('3D骨骼姿态')}</span>
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          style={{ ...cardBody, width: '100%', height: '100%', overflow: 'visible', display: 'flex', flexDirection: 'column', background: 'transparent' }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <div className="nodrag" style={{ position: 'relative', flex: 1, borderRadius: 20, overflow: 'hidden', boxShadow: currentShadow, background: 'rgba(0,0,0,0.2)' }}>


            <iframe
              ref={iframeRef}
              src={viewerUrl}
              onLoad={handleIframeLoad}
              title="3D Pose Viewer"
              style={{
                width: '100%', height: '100%', border: 'none', display: 'block',
                pointerEvents: isConnecting ? 'none' : 'auto',
              }}
              allow="cross-origin-isolated"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />

            {showExtractPrompt && data.status !== 'loading' && (
              <div
                className="nodrag"
                style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 12, padding: 20,
                  background: 'rgba(0,0,0,0.7)',
                  backdropFilter: 'blur(12px)',
                }}
              >
                <div className="w-10 h-10 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-zinc-400">
                  <PoseIcon />
                </div>
                <div style={{ fontSize: 12, color: '#a1a1aa', textAlign: 'center', lineHeight: 1.5 }}>
                  
                  {t('已连接图像，可从中提取 3D 骨骼姿态')}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <button
                    onClick={() => {
                       sendInitMode();
                       updateNodeData(id, { glbUrl: 'default' });
                    }}
                    style={{
                      padding: '6px 12px', borderRadius: 7,
                      background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                      color: '#888', fontSize: 11, fontWeight: 500,
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    
                    {t('编辑默认姿势')}
                  </button>
                  <button
                    onClick={handleExtractPose}
                    disabled={!targetImageUrl}
                    style={{
                      padding: '6px 14px', borderRadius: 7,
                      background: targetImageUrl ? 'rgba(80,140,255,0.2)' : 'rgba(255,255,255,0.06)',
                      border: targetImageUrl ? '1px solid rgba(80,140,255,0.4)' : '1px solid transparent',
                      color: targetImageUrl ? '#7ab4ff' : '#555',
                      fontSize: 11, fontWeight: 500,
                      cursor: targetImageUrl ? 'pointer' : 'not-allowed',
                      fontFamily: 'inherit', transition: 'all 0.2s',
                    }}
                  >
                    
                    {t('提取 3D 骨骼')}
                  </button>

                </div>
              </div>
            )}

            {isOutdated && (
              <div style={{ position: 'absolute', top: 12, left: 0, right: 0, zIndex: 45, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
                <button
                  className="nodrag"
                  onClick={handleExtractPose}
                  disabled={data.status === 'loading'}
                  style={{
                    padding: '6px 14px', borderRadius: 20, pointerEvents: 'auto',
                    background: 'rgba(80,140,255,0.95)', color: '#fff',
                    border: '1px solid rgba(255,255,255,0.2)', fontSize: 12, fontWeight: 500,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
                    cursor: data.status === 'loading' ? 'not-allowed' : 'pointer',
                    opacity: data.status === 'loading' ? 0.7 : 1, transition: 'all 0.2s',
                  }}
                >
                  
                  {t('输入图片已更改，重新提取')}
                </button>
              </div>
            )}

            {(data.status === 'loading' || isSaving) && (
              <div style={{
                position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 10, zIndex: 50,
              }}>
                <Spinner />
                <span style={{ fontSize: 12, color: '#aaa' }}>{isSaving ? t('正在保存...') : t('正在提取骨骼...')}</span>
              </div>
            )}

            {(
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, padding: '14px 10px 8px',
                background: 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%)',
                display: 'flex', alignItems: 'center', gap: 6,
                opacity: showOverlay ? 1 : 0, transition: 'opacity 0.2s',
                pointerEvents: 'none', zIndex: 20,
              }}>
                <button className="nodrag" onClick={handleResetCamera} title={t('重置视角')} style={{ ...iconBtn, pointerEvents: showOverlay ? 'auto' : 'none' }}>
                  <ResetIcon />
                </button>
                <div style={{ flex: 1 }} />



                {data.depthImageUrl && (
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center', gap: 3, pointerEvents: 'none' }}>
                    <DepthIcon />  {t('深度图')}
                  </span>
                )}

                <button
                  className="nodrag"
                  onClick={handleSave}
                  disabled={isSaving}
                  style={{
                    padding: '6px 12px', borderRadius: 8,
                    background: 'rgba(80,140,255,0.3)',
                    border: '1px solid rgba(80,140,255,0.4)',
                    color: '#7ab4ff', fontSize: 12, fontWeight: 500,
                    cursor: isSaving ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit', transition: 'all 0.2s',
                    display: 'flex', alignItems: 'center', gap: 4,
                    opacity: isSaving ? 0.6 : 1,
                    pointerEvents: showOverlay ? 'auto' : 'none'
                  }}
                >
                  <SaveIcon />  {t('保存')}
                </button>
              </div>
            )}

            {data.status === 'error' && data.error && (
              <div
                className="nodrag"
                style={{
                  position: 'absolute', top: 12, left: 12, right: 12, zIndex: 40,
                  padding: '8px 12px', fontSize: 11, color: '#ff6b6b',
                  background: 'rgba(40, 0, 0, 0.9)', backdropFilter: 'blur(10px)',
                  borderRadius: 8, border: '1px solid rgba(255,107,107,0.25)',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <span style={{ flex: 1, lineHeight: 1.5 }}>{data.error}</span>
                  <button
                    onClick={() => updateNodeData(id, { status: 'idle', error: undefined })}
                    style={{
                      background: 'none', border: 'none', color: 'rgba(255,107,107,0.6)',
                      cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0,
                    }}
                  >×</button>
                </div>
                {data.error?.includes(t('识别')) && (
                  <div style={{ fontSize: 10, color: 'rgba(255,150,150,0.6)', lineHeight: 1.4 }}>
                    
                    {t('建议：换一张有完整人体的图，或使用"提取 3D 骨骼"')}
                  </div>
                )}
              </div>
            )}
          </div>

          <IconHandle type="target" id="in-image" portType="image" nodeId={id} style={{ top: '50%' }} />
          <IconHandle type="source" portType="pose" nodeId={id} />
        </div>
      </div>
    </NodeShell>
  );
}

export default memo(PoseNode);

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status?: string }) {
  const map: Record<string, { label: string; color: string }> = {
    idle:    { label: t('空闲'),  color: '#888' },
    loading: { label: t('加载中'), color: '#eee' },
    ready:   { label: '就绪',  color: '#eee' },
    saving:  { label: t('保存中'), color: '#eee' },
    done:    { label: '完成',  color: '#eee' },
    error:   { label: t('错误'),  color: '#f87171' },
  };
  const s = map[status || 'idle'] || map.idle;
  return (
    <span style={{
      fontSize: 9, fontWeight: 600, color: s.color,
      background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
      padding: '1px 6px', borderRadius: 6,
    }}>
      {s.label}
    </span>
  );
}

function Spinner() {
  return (
    <div style={{ width: 28, height: 28, border: '2.5px solid rgba(255,255,255,0.1)', borderTopColor: '#ffffff', borderRadius: '50%', animation: 'gaussian-spin 0.7s linear infinite' }}>
      <style>{`@keyframes gaussian-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
  color: 'rgba(255,255,255,0.8)', borderRadius: 7, padding: '4px 6px', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
};

const actionBtn: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 7,
  background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)',
  color: '#ffffff', fontSize: 11, fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s',
};

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="nodrag"
      onClick={onClick}
      style={{
        padding: '2px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600,
        border: `1px solid ${active ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)'}`,
        background: active ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)',
        color: active ? '#ffffff' : '#888',
        cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  );
}

function PoseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="3" /><line x1="12" y1="8" x2="12" y2="16" />
      <line x1="12" y1="16" x2="8" y2="22" /><line x1="12" y1="16" x2="16" y2="22" />
      <line x1="12" y1="10" x2="6" y2="10" /><line x1="12" y1="10" x2="18" y2="10" />
    </svg>
  );
}
function ResetIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
    </svg>
  );
}
function SaveIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
    </svg>
  );
}
function DepthIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="7" opacity="0.4" />
    </svg>
  );
}
