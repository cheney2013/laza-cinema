'use client';

import type { ReactNode } from 'react';

/**
 * 界面图标的唯一出处 —— 顶栏和节点标题栏共用同一套字形。
 *
 * 原先两边都在用 emoji（🎬🎥🎭🗂✂️⚡）。emoji 的颜色由字体决定，按钮的
 * idle / hover / active 三态染不到它；各系统字形宽高又不一致，一排按钮的
 * 基线会参差。这里一律 `currentColor` 描边，颜色只在按钮上定义一次。
 */
export function LineIcon({ size = 12, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

/** 场记板 —— 导演台 */
export const ClapperIcon = ({ size }: IconProps = {}) => (
  <LineIcon size={size}>
    <path d="M3 10v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9z" />
    <path d="M3.5 10 2.8 6.6a1 1 0 0 1 .8-1.2l15-3a1 1 0 0 1 1.2.8l.6 3.2z" />
    <path d="m8 4.3 1.6 3.4M13.4 3.2 15 6.6" />
  </LineIcon>
);

/** 摄影机 —— 运镜 / 镜头 */
export const CameraIcon = ({ size }: IconProps = {}) => (
  <LineIcon size={size}>
    <path d="M2 8.5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 14 8.5v7A1.5 1.5 0 0 1 12.5 17h-9A1.5 1.5 0 0 1 2 15.5z" />
    <path d="m14 11 5.4-3.1a.8.8 0 0 1 1.2.7v6.8a.8.8 0 0 1-1.2.7L14 13z" />
  </LineIcon>
);

/** 半身人像 —— 演员 */
export const CastIcon = ({ size }: IconProps = {}) => (
  <LineIcon size={size}>
    <circle cx="12" cy="8" r="3.4" />
    <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
  </LineIcon>
);

/** 标签 —— 别名 */
export const TagIcon = ({ size }: IconProps = {}) => (
  <LineIcon size={size}>
    <path d="M3 12.6V4a1 1 0 0 1 1-1h8.6a1 1 0 0 1 .7.3l7.4 7.4a1 1 0 0 1 0 1.4l-8.6 8.6a1 1 0 0 1-1.4 0L3.3 13.3a1 1 0 0 1-.3-.7z" />
    <circle cx="7.5" cy="7.5" r="1.2" />
  </LineIcon>
);

/** 闪电 —— 潜空间张量就绪 */
export const BoltIcon = ({ size }: IconProps = {}) => (
  <LineIcon size={size}>
    <path d="M13.2 2.5 4.8 13.2a.6.6 0 0 0 .5 1h5.1l-.6 7.3 8.4-10.7a.6.6 0 0 0-.5-1h-5.1z" />
  </LineIcon>
);

/** 四角星 —— AI 处理 / 像素重建 */
export const SparkIcon = ({ size }: IconProps = {}) => (
  <LineIcon size={size}>
    <path d="M12 3.5 13.9 9 19.5 11 13.9 13 12 18.5 10.1 13 4.5 11 10.1 9z" />
  </LineIcon>
);

/** 分格胶片 —— 素材库 */
export const LibraryIcon = ({ size }: IconProps = {}) => (
  <LineIcon size={size}>
    <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
    <path d="M7.5 4.5v15M16.5 4.5v15M2.5 12h19" />
  </LineIcon>
);

/** 剪刀 —— 剪辑台 */
export const ScissorsIcon = ({ size }: IconProps = {}) => (
  <LineIcon size={size}>
    <circle cx="6" cy="18" r="2.6" />
    <circle cx="6" cy="6" r="2.6" />
    <path d="M20 4 8.1 16.4M20 20 8.1 7.6" />
  </LineIcon>
);

/** 齿轮 —— 节点的设置开关。所有节点标题栏的设置按钮都用它 */
export const GearIcon = ({ size }: IconProps = {}) => (
  <LineIcon size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </LineIcon>
);
