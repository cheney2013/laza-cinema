import React, { useState, useCallback, useEffect, useRef, memo } from 'react';
import { areNodePropsEqual } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { InpaintNode as InpaintNodeType, InpaintNodeData } from '@/lib/types';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { NodeHeaderIconButton } from './nodeChrome';
import { GearIcon } from '@/components/ui/icons';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import GeneratingLine from './GeneratingLine';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult } from '@/hooks/useJobPoller';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import { t } from '@/lib/i18n';

function InpaintNode({ id, data, selected }: NodeProps<InpaintNodeType>) {
  const { setNodes, updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);

  const [refImageSrc, setRefImageSrc] = useState<string | null>(null);
  const [generatedSrc, setGeneratedSrc] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(16);
  const [isDrawMode, setIsDrawMode] = useState(true);
  const [maskBackup, setMaskBackup] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const cancelledRef = useRef(false);

  const jobResult = useJobResult(data.jobId as string | undefined);
  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, { status: 'done', generatedUrl: jobResult.url, jobId: undefined });
      setIsGenerating(false);
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('重绘失败'), jobId: undefined });
      setIsGenerating(false);
    } else if (jobResult.status === 'cancelled') {
      // Cancelled elsewhere (another tab, the API, a script): stop waiting on it.
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
      setIsGenerating(false);
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve connected base image
  const baseImage = connected.find((n) => n.targetHandle === 'in-image');
  const baseImageUrl = baseImage ? (baseImage.generatedUrl || baseImage.url) as string | null : null;

  // Clear mask canvas
  const handleClearMask = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      setMaskBackup(null);
    }
  }, []);

  // Fetch / Load base image
  useEffect(() => {
    if (!baseImageUrl) {
      setRefImageSrc(null);
      handleClearMask();
      return;
    }
    const url = baseImageUrl.startsWith('http') ? baseImageUrl : `${API_BASE}${baseImageUrl}`;
    let blobUrl: string | null = null;
    fetch(url)
      .then((r) => r.blob())
      .then((blob) => {
        blobUrl = URL.createObjectURL(blob);
        setRefImageSrc(blobUrl);
      })
      .catch(() => setRefImageSrc(url));
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [baseImageUrl, handleClearMask]);

  // Load generated output image
  useEffect(() => {
    if (!data.generatedUrl) {
      setGeneratedSrc(null);
      return;
    }
    const url = `${API_BASE}${data.generatedUrl}`;
    let blobUrl: string | null = null;
    fetch(url)
      .then((r) => r.blob())
      .then((blob) => {
        blobUrl = URL.createObjectURL(blob);
        setGeneratedSrc(blobUrl);
      })
      .catch(() => setGeneratedSrc(url));
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [data.generatedUrl]);

  // Restore drawing mask on resize
  const dimensionsStr = useStore((state) => {
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return '280x300';
    const w = node.measured?.width || node.width || 280;
    const h = node.measured?.height || node.height || 300;
    return `${w}x${h}`;
  });
  const [width, height] = dimensionsStr.split('x').map(Number);

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (canvas && img && img.clientWidth > 0 && img.clientHeight > 0) {
      if (canvas.width !== img.clientWidth || canvas.height !== img.clientHeight) {
        canvas.width = img.clientWidth;
        canvas.height = img.clientHeight;
        
        if (maskBackup) {
          const tempImg = new Image();
          tempImg.onload = () => {
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(tempImg, 0, 0, canvas.width, canvas.height);
            }
          };
          tempImg.src = maskBackup;
        }
      }
    }
  }, [width, height, maskBackup]);

  // Handle Drawing Inputs (Mouse & Touch)
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (isDrawMode) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.55)'; // Neon-red mask overlay
    } else {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    }

    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (canvas) {
      setMaskBackup(canvas.toDataURL());
    }
  };

  // Touch Support
  const startDrawingTouch = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const touch = e.touches[0];

    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (isDrawMode) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.55)';
    } else {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    }

    ctx.beginPath();
    ctx.moveTo(touch.clientX - rect.left, touch.clientY - rect.top);
    setIsDrawing(true);
  };

  const drawTouch = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const touch = e.touches[0];

    ctx.lineTo(touch.clientX - rect.left, touch.clientY - rect.top);
    ctx.stroke();
  };

  const handleCancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) {
      try { await api.cancelJob(data.jobId); } catch {}
    }
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    setIsGenerating(false);
  }, [id, updateNodeData, data.jobId]);

  const handleGenerate = useCallback(async () => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!baseImageUrl || !canvas || !img || isGenerating) return;

    cancelledRef.current = false;
    setIsGenerating(true);
    updateNodeData(id, { status: 'generating', jobId: undefined, error: undefined });

    try {
      // Create high-res offscreen mask canvas
      const offCanvas = document.createElement('canvas');
      offCanvas.width = img.naturalWidth || 1024;
      offCanvas.height = img.naturalHeight || 1024;
      const offCtx = offCanvas.getContext('2d');
      if (!offCtx) throw new Error('Failed to create offscreen drawing context');

      // 1. Fill solid black
      offCtx.fillStyle = '#000000';
      offCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);

      // 2. Draw the transparent red screen strokes canvas stretched over it.
      // (The red pixels will draw on top of black, producing the exact red-mask ComfyUI expects)
      offCtx.drawImage(canvas, 0, 0, offCanvas.width, offCanvas.height);

      // 3. Convert to blob and construct file
      offCanvas.toBlob(async (maskBlob) => {
        if (!maskBlob) {
          setIsGenerating(false);
          updateNodeData(id, { status: 'error', error: t('无法生成遮罩文件') });
          return;
        }

        const maskFile = new File([maskBlob], `mask_${Date.now()}.png`, { type: 'image/png' });
        try {
          // Upload Mask File
          const maskUpload = await api.uploadStyleReference(maskFile);

          const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(
            data.seed as number | undefined,
            data.seedMode as any,
            81000
          );

          if (data.seedMode === 'random') {
            updateNodeData(id, { seed: nextSeedToStore });
          }

          // Trigger inpainting job
          const { job_id } = await api.generateInpaint({
            image_url: baseImageUrl,
            mask_url: maskUpload.url,
            prompt: data.prompt || '',
            steps: data.steps || 20,
            cfg: data.cfg || 4.0,
            seed: effectiveSeed,
          });

          if (cancelledRef.current) return;
          updateNodeData(id, { jobId: job_id });

        } catch (e: any) {
          if (!cancelledRef.current) {
            updateNodeData(id, { status: 'error', error: e.message, jobId: undefined });
            setIsGenerating(false);
          }
        }
      }, 'image/png');

    } catch (e: any) {
      if (!cancelledRef.current) {
        updateNodeData(id, { status: 'error', error: e.message, jobId: undefined });
        setIsGenerating(false);
      }
    }
  }, [baseImageUrl, data, id, updateNodeData, isGenerating]);

  const currentShadow = selected ? selectedShadow : defaultShadow;
  const isGeneratingState = data.status === 'generating' || isGenerating;
  const canGenerate = comfyuiOnline && !!baseImageUrl && maskBackup !== null;

  const sizing = useNodeSizing({
    id,
    type: 'inpaint',
    rows: ['header', 'settings'],
    activeRows: showSettings ? ['header', 'settings'] : ['header'],
    paddingX: 0,
    ratioSources: [
      { width: data.width as number | undefined, height: data.height as number | undefined },
    ],
    hasMedia: Boolean(baseImageUrl),
    userWidth: data.userWidth as number | undefined,
  });

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
          <InpaintIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('局部重绘')}</span>
        </div>
        <NodeHeaderIconButton active={showSettings} onClick={() => setShowSettings((v) => !v)} title={t('设置')}>
          <GearIcon />
        </NodeHeaderIconButton>
      </div>
      {showSettings && (
        <div data-chrome-row="settings" className="node-shell-drawer nodrag nowheel p-3 text-xs animate-in fade-in duration-150">
          <SettingsPanel data={data} id={id} updateNodeData={updateNodeData} inline />
        </div>
      )}

      <div data-node-media style={{ position: 'relative', flex: 1, minHeight: 0, borderRadius: 20 }}>
        <div
          style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.3)' }}
          onMouseEnter={() => setIsFocused(true)}
          onMouseLeave={() => { setIsFocused(false); stopDrawing(); }}
        >
          {refImageSrc ? (
            <div style={{ position: 'relative', flex: 1, width: '100%', height: '100%', userSelect: 'none', WebkitUserSelect: 'none' }}>
              <img
                ref={imgRef}
                src={data.generatedUrl ? generatedSrc || undefined : refImageSrc}
                alt="Inpaint Base"
                crossOrigin="anonymous"
                decoding="async"
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  sizing.onMediaSize(img.naturalWidth, img.naturalHeight);
                  const canvas = canvasRef.current;
                  if (canvas) {
                    canvas.width = img.clientWidth;
                    canvas.height = img.clientHeight;
                  }
                }}
              />

              {/* Painting Canvas overlay */}
              {!data.generatedUrl && (
                <canvas
                  ref={canvasRef}
                  onMouseDown={startDrawing}
                  onMouseMove={draw}
                  onMouseUp={stopDrawing}
                  onMouseLeave={stopDrawing}
                  onTouchStart={startDrawingTouch}
                  onTouchMove={drawTouch}
                  onTouchEnd={stopDrawing}
                  style={{
                    position: 'absolute', inset: 0, zIndex: 10,
                    cursor: isDrawMode ? 'crosshair' : 'cell',
                    touchAction: 'none',
                  }}
                />
              )}

              {/* Transparent paint tools control overlay */}
              {!data.generatedUrl && isFocused && (
                <div className="nodrag" style={{
                  position: 'absolute', top: 8, left: 8, right: 8, zIndex: 20,
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'rgba(10, 10, 16, 0.88)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                  padding: '5px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.12)'
                }}>
                  <button onClick={() => setIsDrawMode(true)} title={t('画笔')} style={{
                    background: isDrawMode ? 'rgba(255,255,255,0.2)' : 'none',
                    border: isDrawMode ? '1px solid rgba(255,255,255,0.3)' : '1px solid transparent',
                    cursor: 'pointer', padding: '3px 6px', borderRadius: 6, color: '#fff',
                  }}>
                    <BrushIcon />
                  </button>
                  <button onClick={() => setIsDrawMode(false)} title={t('橡皮擦')} style={{
                    background: !isDrawMode ? 'rgba(255,255,255,0.2)' : 'none',
                    border: !isDrawMode ? '1px solid rgba(255,255,255,0.3)' : '1px solid transparent',
                    cursor: 'pointer', padding: '3px 6px', borderRadius: 6, color: !isDrawMode ? '#fff' : '#888',
                  }}>
                    <EraserIcon />
                  </button>
                  <button onClick={handleClearMask} title={t('清除遮罩')} style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#aaa', marginLeft: 'auto'
                  }}>
                    <TrashIcon />
                  </button>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 6 }}>
                    <span style={{ fontSize: 9, color: '#aaa', fontFamily: 'monospace' }}>{t('粗细')}</span>
                    <input type="range" min="4" max="48" value={brushSize}
                      onChange={(e) => setBrushSize(+e.target.value)}
                      style={{ width: 48, height: 3, accentColor: '#ffffff', cursor: 'pointer' }}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', color: '#666', fontSize: 11, textAlign: 'center' }}>
              <div style={{ marginBottom: 8, opacity: 0.5 }}><InpaintIcon size={24} /></div>
              
              {t('请在左侧连接一张角色/场景图开始重绘')}
            </div>
          )}

          {/* Settings / Prompt bar */}
          {refImageSrc && (
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 15,
              padding: '20px 10px 8px',
              background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)',
              display: 'flex', flexDirection: 'column', gap: 6,
              opacity: isFocused ? 1 : 0, transition: 'opacity 0.2s',
              pointerEvents: isFocused ? 'auto' : 'none'
            }}>
              <div onDoubleClick={() => setIsEditing(true)} style={{ display: 'flex', minHeight: 0 }}>
                {isEditing ? (
                  <textarea className="nodrag"
                    autoFocus
                    style={{ flex: 1, width: '100%', background: 'rgba(0,0,0,0.4)', border: 'none', outline: 'none', resize: 'none', color: '#e8e8e8', fontSize: 11, lineHeight: 1.4, fontFamily: 'inherit', height: 42, padding: '4px 6px', borderRadius: 6 }}
                    placeholder={t('输入局部重绘引导词…')}
                    value={data.prompt || ''}
                    onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
                    onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
                    onBlur={() => { setIsEditing(false); window.dispatchEvent(new Event('inputBlurred')); }}
                  />
                ) : (
                  <div style={{ flex: 1, color: data.prompt ? '#e8e8e8' : '#888', fontSize: 11, lineHeight: 1.4, fontFamily: 'inherit', whiteSpace: 'pre-wrap', maxHeight: 42, overflowY: 'auto' }}>
                    {data.prompt || t('双击输入重绘提示词…')}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {data.generatedUrl && (
                  <button className="nodrag" onClick={() => updateNodeData(id, { generatedUrl: null })}
                    style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: 9 }}>
                    
                    {t('重新涂抹')}
                  </button>
                )}

                <button className="nodrag"
                  onClick={handleGenerate}
                  disabled={isGeneratingState || !canGenerate}
                  style={{
                    marginLeft: 'auto', padding: '4px 10px', borderRadius: 6,
                    background: canGenerate ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
                    color: canGenerate ? '#fff' : '#666', border: 'none', fontSize: 10, fontWeight: 500,
                    cursor: isGeneratingState || !canGenerate ? 'not-allowed' : 'pointer'
                  }}
                >
                  
                  {t('开始重绘')}
                </button>
              </div>
            </div>
          )}

          <GeneratingLine active={isGeneratingState} jobId={data.jobId as string | undefined} steps={data.steps || 20} onCancel={handleCancel} />
        </div>

        {data.status === 'error' && (
          <div style={{
            position: 'absolute', top: 12, left: 12, right: 12, zIndex: 40,
            padding: '6px 10px', fontSize: 11, textAlign: 'center', color: '#ff6b6b',
            background: 'rgba(40, 0, 0, 0.85)', backdropFilter: 'blur(10px)',
            borderRadius: 8, border: '1px solid rgba(255,107,107,0.25)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)', pointerEvents: 'none'
          }}>
            
            {t('重绘失败:')} {data.error || t('未知错误')}
          </div>
        )}
      </div>

      <IconHandle type="target" id="in-image" portType="image" nodeId={id} title={t('基础参考图像')} style={{ top: '50%' }} />
      <IconHandle type="source" portType="image" nodeId={id} title={t('重绘输出图像')} />
    </NodeShell>
  );
}

export default memo(InpaintNode, areNodePropsEqual);

function SettingsPanel({ data, id, updateNodeData, inline }: {
  data: InpaintNodeData; id: string; updateNodeData: any; inline?: boolean;
}) {
  const rows = [
    {
      label: t('生成步数 (Steps)'),
      value: data.steps || 20,
      set: (v: number) => updateNodeData(id, { steps: v }),
      min: 1,
      max: 50,
      step: 1,
    },
    {
      label: t('引导系数 (CFG)'),
      value: data.cfg || 4.0,
      set: (v: number) => updateNodeData(id, { cfg: v }),
      min: 1.0,
      max: 10.0,
      step: 0.1,
    },
  ];

  const inner = (
    <>
      {rows.map(({ label: lbl, value, set, min, max, step }) => (
        <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 10, color: '#bbb' }}>
          <span>{lbl}</span>
          <input type="number" className="nodrag"
            style={{
              width: 72, background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 6,
              padding: '2px 8px', textAlign: 'right', color: '#fff', fontSize: 10, outline: 'none'
            }}
            value={value} min={min} max={max} step={step}
            onChange={(e) => set(+e.target.value)}
            onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
            onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
          />
        </div>
      ))}
      <div className="pt-2 mt-2 border-t border-white/10">
        <SeedControl
          seed={data.seed as number | undefined}
          seedMode={data.seedMode as any}
          onChange={(newSeed, newMode) => {
            updateNodeData(id, { seed: newSeed, seedMode: newMode });
            window.dispatchEvent(new Event('takeSnapshot'));
          }}
        />
      </div>
    </>
  );

  if (inline) return <>{inner}</>;

  return (
    <div style={{ background: '#1c1c1c', borderRadius: '0 0 20px 20px', padding: '12px 14px 14px', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 30 }}>
      {inner}
    </div>
  );
}

function InpaintIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" />
      <path d="M12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18Z" strokeDasharray="3 3" />
    </svg>
  );
}

function BrushIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
      <path d="M7.5 10.5c.83-1.5 2.5-3 4.5-3s3.67 1.5 4.5 3" />
      <path d="M11.5 17.5c.28.28.72.28 1 0l3.5-3.5-1-1-3.5 3.5c-.28.28-.28.72 0 1z" />
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m20 20-3.5-3.5" />
      <path d="M22 9c-2.21 0-4-1.79-4-4" />
      <path d="M20 13c-2.21 0-4-1.79-4-4" />
      <path d="m3 17 6 6 12-12-6-6z" />
      <path d="m14 8 5 5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
    </svg>
  );
}

