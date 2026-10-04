'use client';

import { useState } from 'react';
import type { CSSProperties, FocusEvent, ReactNode } from 'react';

/**
 * A hover bar stays up while a text field inside it has focus: the mouse leaving
 * the node must not hide the field being typed in. Once focus leaves, `visible`
 * decides again.
 */
export function useTypingInside() {
  const [typing, setTyping] = useState(false);
  const isField = (el: EventTarget | null) =>
    el instanceof HTMLElement &&
    (el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'file', 'submit'].includes(el.type)) ||
      el.isContentEditable);
  return {
    typing,
    onFocus: (e: FocusEvent<HTMLDivElement>) => { if (isField(e.target)) setTyping(true); },
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      if (!isField(e.relatedTarget) || !e.currentTarget.contains(e.relatedTarget as Node)) setTyping(false);
    },
  };
}

/**
 * 素材画面上的公共操作层 —— 图片素材与视频素材共用同一套语言。
 *
 * 这两种素材原本各写各的：图片是一整块毛玻璃盖住画面 + 大圆钮 + 右下角标，视频是
 * 顶栏一条小图标。同一个上传节点里换个文件就换一套交互，按钮位置、尺寸、悬停时机
 * 全对不上。统一到这里之后，两边只剩"动词"不同：
 *
 *   MediaTopBar     右上一条渐隐工具栏，永远只占一条，绝不压住画面
 *   MediaIconButton 栏内按钮，24px 命中区，danger 变体给移除用
 *   MediaCenterButton 画面正中的主行动位 —— 视频是播放，图片是放大
 *
 * 所有交互件都带 `nodrag` 并吞掉 mousedown：不吞的话按下去会变成拖节点，
 * 按钮只在鼠标不动时才生效。
 */

/**
 * 关掉浏览器自己往画面上贴的那套浮层。
 *
 * Chrome 会在视频右上角浮出画中画与"小窗播放"两颗按钮，它们跟节点自带的顶栏抢同一块
 * 地方，而且点进去画面就飞出画布了。右键菜单里的下载/倍速同理 —— 节点里的视频是画布
 * 的一部分，不是一个独立播放器。
 *
 * 每个渲染画布内视频的 `<video>` 都要展开这一组，别再逐个写。
 */
/**
 * 画布上闲置的视频卡不挂 <video>。
 *
 * 2026-09-05 量过：55 个节点、19 个 <video>，平移一次主线程长任务 1.5 s；把 video 元素
 * 拿掉只剩 0.1 s。暂停中的视频每次画面移动照样按视频层重绘。所以卡片只在播放、悬停、
 * 选中时挂 <video>，其余时间显示第一次加载时从视频抓下来的一帧 JPEG。
 *
 * 抓帧按 src 缓存在模块里；切换项目/刷新页面重抓一次，成本是每个视频一次 loadeddata。
 */
const POSTER_CACHE = new Map<string, string>();

export function cachedPoster(src: string | undefined | null): string | null {
  return src ? POSTER_CACHE.get(src) ?? null : null;
}

export function capturePoster(video: HTMLVideoElement, src: string): string | null {
  if (!src) return null;
  const hit = POSTER_CACHE.get(src);
  if (hit) return hit;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return null;
  try {
    const scale = Math.min(1, 640 / vw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vw * scale));
    canvas.height = Math.max(1, Math.round(vh * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.72);
    POSTER_CACHE.set(src, url);
    return url;
  } catch {
    // cross-origin or tainted canvas: no poster, the card keeps its <video>
    return null;
  }
}

export const NATIVE_VIDEO_CHROME_OFF = {
  disablePictureInPicture: true,
  disableRemotePlayback: true,
  controlsList: 'nodownload noplaybackrate noremoteplayback nofullscreen',
} as const;

// ── 顶栏 ────────────────────────────────────────────────────────────────────

export function MediaTopBar({ visible, children }: { visible?: boolean; children: ReactNode }) {
  const { typing, onFocus, onBlur } = useTypingInside();
  return (
    <div
      className={`nodrag absolute top-0 left-0 right-0 z-20 flex items-center justify-end gap-1 p-1.5 bg-gradient-to-b from-black/60 to-transparent transition-opacity duration-150 ${
        visible || typing ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/**
 * 底栏：顶栏的镜像，压在画面下沿。
 *
 * 节点的操作区原先是卡片里一条实心行，靠 `border-t` 和画面切开 —— 那是一种"有底"的
 * 控件语言，跟画面上那套浮着的毛玻璃药丸不是一回事。同一张卡片上出现两种语言，
 * 底下那条就总显得是外挂上去的。
 *
 * 浮起来之后它也不再吃节点高度：节点 = 标题栏 + 画面，尺寸方程少一项。
 */
export function MediaBottomBar({
  visible,
  column,
  children,
}: {
  visible?: boolean;
  /** 纵向堆叠：一格浮层里既要放列表又要放操作排时用，渐变与显隐只有一份 */
  column?: boolean;
  children: ReactNode;
}) {
  const { typing, onFocus, onBlur } = useTypingInside();
  return (
    <div
      className={`nodrag absolute bottom-0 left-0 right-0 z-20 gap-2 px-2 py-1.5 bg-gradient-to-t from-black/90 via-black/70 to-transparent transition-opacity duration-150 ${
        column ? 'flex flex-col' : 'flex items-center'
      } ${visible === false && !typing ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export interface MediaIconButtonProps {
  title?: string;
  danger?: boolean;
  /** 开关态按钮（循环 / 声音）：亮起表示已启用 */
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
}

export function MediaIconButton({ title, danger, active, className, style, onClick, children }: MediaIconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      className={`nodrag w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-md border bg-black/50 backdrop-blur-sm transition-colors cursor-pointer ${
        danger
          ? 'border-white/10 text-zinc-300 hover:text-white hover:bg-rose-600/80 hover:border-rose-400/40'
          : active
            ? 'border-white/30 bg-white/20 text-white hover:bg-white/30'
            : 'border-white/10 text-zinc-300 hover:text-white hover:bg-white/20 hover:border-white/25'
      }${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
}

/**
 * 画面正中的主行动位。
 *
 * 只做一枚圆钮而不是整块覆盖层 —— 覆盖层带 nodrag 会把整张画面变成不可拖动，
 * 而画面正是拖节点时最顺手的抓取区。
 */
export function MediaCenterButton({
  title,
  dimmed,
  onClick,
  children,
}: {
  title?: string;
  /** 非悬停态：压暗但仍可见（视频的播放键就该常驻提示"这是能动的"） */
  dimmed?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      className={`nodrag absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 w-12 h-12 rounded-full bg-black/55 backdrop-blur-sm border border-white/25 flex items-center justify-center text-white shadow-lg hover:bg-black/80 transition-all duration-150 cursor-pointer ${
        dimmed ? 'opacity-65' : 'opacity-100'
      }`}
    >
      {children}
    </button>
  );
}

// ── 图标 ────────────────────────────────────────────────────────────────────

/** 描边图标的公共外壳：12px、currentColor、圆角端点 */
export function Stroke({ size = 12, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function MediaUploadIcon() {
  return (
    <Stroke>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </Stroke>
  );
}

export function MediaMaximizeIcon({ size = 12 }: { size?: number } = {}) {
  return (
    <Stroke size={size}>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </Stroke>
  );
}

export function MediaCameraIcon({ size = 12 }: { size?: number } = {}) {
  return (
    <Stroke size={size}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </Stroke>
  );
}

export function MediaCopyIcon() {
  return (
    <Stroke>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Stroke>
  );
}

export function MediaCheckIcon() {
  return (
    <Stroke>
      <path d="M20 6L9 17l-5-5" />
    </Stroke>
  );
}

export function MediaDownloadIcon() {
  return (
    <Stroke>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </Stroke>
  );
}

export function MediaCloseIcon() {
  return (
    <Stroke>
      <path d="M6 6l12 12M18 6L6 18" />
    </Stroke>
  );
}

export function MediaSpinnerIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ── 画面缺席时的占位 ────────────────────────────────────────────────────────

/**
 * 媒体区还没有画面时的占位。
 *
 * 「上传素材」的空态早就长这样：虚线框 + 圆形图标 + 一句主文案 + 一句补充。生成类节点
 * 各自写的是一行灰字居中，同一张画布上"还没东西"这件事说了两种话。抽出来共用，
 * 剩下的差异只有文案。
 */
export function MediaEmptyState({
  icon,
  title,
  hint,
  active,
  className,
  children,
  rootProps,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  /** 高亮态：拖放悬停等"马上就要有东西了"的时刻 */
  active?: boolean;
  className?: string;
  /** 附加内容，例如支持的格式行 */
  children?: ReactNode;
  /** 透传给根元素，给 dropzone 的 getRootProps 用 */
  rootProps?: Record<string, unknown>;
}) {
  return (
    <div
      {...rootProps}
      className={`border border-dashed rounded-2xl p-4 text-center transition-all flex flex-col items-center justify-center gap-2 flex-1 min-h-[140px] m-1.5 select-none ${
        active
          ? 'border-white/70 bg-white/10 text-white shadow-[0_0_20px_rgba(255,255,255,0.08)]'
          : 'border-white/15'
      }${className ? ` ${className}` : ''}`}
    >
      {icon && (
        <div className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-zinc-300 transition-colors">
          {icon}
        </div>
      )}
      <div className="text-xs text-zinc-300 font-medium leading-tight">{title}</div>
      {hint && <div className="text-[9px] text-zinc-500 leading-relaxed">{hint}</div>}
      {children}
    </div>
  );
}

/**
 * 标题栏右侧的参数角标 —— 分辨率、时长、帧率那一条。
 *
 * 字号、配色、圆角在各节点里抄歪过（9px / 10px、有边框 / 无边框），统一到这里。
 */
export function MediaMetaChip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="text-[9px] font-mono text-zinc-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5 flex-shrink-0 whitespace-nowrap"
    >
      {children}
    </span>
  );
}
