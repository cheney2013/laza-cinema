'use client';

import type { ReactNode } from 'react';
import { MediaBottomBar } from './mediaChrome';

/**
 * 节点底部操作排 —— 参数控件在左、主行动键在右的那一条。
 *
 * 三个节点各抄了一份同样的类名串，抄的过程中就走样了：角色重构与动作迁移是
 * 「滑杆 + 种子 + 一枚不宽的按钮」，演员掩码只有一枚 `flex-1` 的按钮，于是它被拉满整行，
 * 看上去完全是另一种控件。把排和键都收进来，各节点只挑强调色。
 *
 * 这条排就是画面上那套浮层的下半截（`MediaBottomBar`），不是卡片里一条实心行 ——
 * 项目里的控件一律浮在画面上，底下再挂一条带 border-t 的实心条会是另一种语言。
 * 控件本身也随之改成毛玻璃底，好压在画面上仍然读得清。
 */

// 压在画面上，底色要够实才读得清 —— 卡片里那套 /15 的淡色在亮画面上会糊掉
const ACCENTS = {
  violet: 'bg-violet-500/70 border-violet-300/40 text-white hover:bg-violet-500/90',
  teal: 'bg-teal-500/70 border-teal-300/40 text-white hover:bg-teal-500/90',
  sky: 'bg-sky-500/70 border-sky-300/40 text-white hover:bg-sky-500/90',
  neutral: 'bg-black/55 border-white/20 text-zinc-100 hover:bg-black/80',
} as const;

export type NodeActionAccent = keyof typeof ACCENTS;

export function NodeActionRow({ visible, children }: { visible?: boolean; children: ReactNode }) {
  return <MediaBottomBar visible={visible}>{children}</MediaBottomBar>;
}

/**
 * 主行动键。
 *
 * `grow` 决定它是否吃掉剩余宽度 —— 排里还有别的控件时吃，独自一枚时**不吃**：
 * 拉满整行的按钮和挤在右边的按钮读起来是两个东西，而它们做的是同一件事。
 */
export function NodeActionButton({
  accent = 'violet',
  grow,
  disabled,
  title,
  onClick,
  children,
}: {
  accent?: NodeActionAccent;
  grow?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`nodrag text-[10px] font-medium py-1 rounded-lg border backdrop-blur-md shadow-lg transition-colors disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer ${
        grow ? 'flex-1' : 'px-4 ml-auto'
      } ${ACCENTS[accent]}`}
    >
      {children}
    </button>
  );
}

/** 操作排左侧的说明文字，和 `MediaMetaChip` 一样只是把字号配色定死在一处 */
export function NodeActionHint({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="text-[9px] text-zinc-300 min-w-0 truncate px-1.5 py-0.5 rounded-md bg-black/50 border border-white/10 backdrop-blur-md"
    >
      {children}
    </span>
  );
}

/**
 * 节点标题栏右侧的控件 —— 抽屉开关、跳板入口、齿轮。
 *
 * 各节点原本各写各的类名串：导演台紫、运镜黄、演员红、齿轮又是另一套内联 style，
 * 同一条标题栏上就出现了四种控件语言，而它们做的都是同一件事（打开一块面板）。
 * 颜色留给状态标签（Latent 那种胶囊），按钮一律中性玻璃底，
 * 只用 `active` 表示"这块面板正开着"。
 */
const HEADER_BTN_BASE =
  'nodrag inline-flex items-center gap-1 rounded-md text-[10px] font-medium border-0 transition-colors cursor-pointer ' +
  'disabled:opacity-35 disabled:cursor-not-allowed';
const HEADER_BTN_IDLE = 'bg-transparent hover:bg-white/10 text-zinc-400 hover:text-white';
const HEADER_BTN_ACTIVE = 'bg-white/15 text-white';

export function NodeHeaderButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${HEADER_BTN_BASE} px-1.5 py-0.5 ${active ? HEADER_BTN_ACTIVE : HEADER_BTN_IDLE}`}
    >
      {children}
    </button>
  );
}

/** 只放一枚图标的方形版本（齿轮等），命中区与文字键同高 */
export function NodeHeaderIconButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${HEADER_BTN_BASE} justify-center w-[22px] h-[22px] ${active ? HEADER_BTN_ACTIVE : HEADER_BTN_IDLE}`}
    >
      {children}
    </button>
  );
}
