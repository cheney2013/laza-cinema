# 2026-10-04 更新：高度由卡片自己的排版决定（已迁移的节点）

这份文档下面写的"方程 + 实测控件区高度"是旧模型。黑边、悬浮才恢复、外部写入的高度（整理、MCP、旧存档）留在节点上，都出在它：高度被存下来，又靠一个钩子维护，谁绕过钩子写了值，卡片就停在错的高度上。

新模型（`hooks/useAutoHeightNode.ts` + `NodeShell` 的 `autoHeight`）：

- 节点只存宽度 `data.userWidth`。高度从不存：钩子发现节点上有高度就清掉，交给 React Flow 按排版去量。
- 画面放在 `aspect-ratio` 等于画面自己比例的盒子里，所以卡片不可能比画面高或矮；控件区、标签、设置抽屉是流内的行，按内容自然排布；编辑视图按内容自然高度，设上下限，超出滚动。
- 比例来源：已加载媒体自己的尺寸 → `data.width/height` → 16:9。
- 缩放手柄只改宽度。设置抽屉打开且有画面时，画面隐藏（`mediaHidden`）。
- MCP 的 `_apply_size` 对这些类型只写宽度（`AUTO_HEIGHT_TYPES`）。
- 缩小到轮廓模式时，底板用 `cover` 铺封面（`contain` 会因为底板是整张卡片而留黑边）。

已迁移：`charswap`、`video`、`videoEdit`、`image`（上传）、`qwenImage`、`preview`、`imageUpscale`、`videoUpscale`、`videoInterpolate`。
还在旧模型上（靠 `useAutoFitNode` 监听存的尺寸兜底）：`prompt`、`audioGen`、`audioRefine`、`chainPreview`、`characterSheet`、`depthVideo`、`gaussian`、`gaussianViewer`、`inpaint`、`pose`、`reangle`、`videoCompare`、`videoTrim`、`wardrobeSwap`。其中带画布交互的（遮罩、姿态、高斯预览）迁移前要先确认交互在自然高度下还成立。

---

# 节点尺寸系统重构设计

## 0. 术语

- **功能区 (chrome)** —— 节点内的**功能按钮与控件**：标题条上的按钮、底部主操作按钮、seed 控件、状态条。
  **不含**媒体区，**不含**提示词编辑器 / 参考图缩略图条这类内容区。
- **媒体区 (media)** —— 视频 / 图片 / 画布，唯一需要保持宽高比的部分。
- **内容区 (content)** —— 提示词编辑器、参考图条、错误横幅等。

## 0.1 本期范围

**只做功能区与媒体区。内容区的形态本期不动** —— 不做计数 chip、不做浮层编辑器、不改它的任何 JSX。
它在新骨架里只拿到一个安全槽位：**可伸缩、自带滚动**，从而不再挤压别人、也不再被静默裁掉。

由此确定了三者的弹性次序，这正是三条规则的直接推论：

| 槽位 | 弹性 | 依据 |
|---|---|---|
| 功能区 | `flex-shrink: 0`，永不压缩 | 规则一：它是尺寸下限的来源 |
| 媒体区 | 不可压缩，高度由比例锁死 | 规则二：保持媒体比例 |
| 内容区 | **唯一的弹性槽**，挤不下就滚动 | 剩下的那个 |

## 1. 尺寸模型

节点尺寸只有**一个自由度：宽度**。高度是因变量：

```
下限（拖拽 / NodeResizer）：  minH = chromeH_compact + minW / ratio_media
自然高（新建 / 适配内容）：  H(W) = chromeH_full + contentH_natural + W / ratio_media
```

**两个方程的差别就是内容区**：它进得了"自然高"，进不了"下限"。
于是节点被拖到最小时，功能区与媒体区完好，内容区滚动收起 —— 不需要为它设计任何退化形态，
这也是"先不管内容区"能自洽的原因。

三条规则由此落地：

| 规则 | 在模型里的位置 |
|---|---|
| 最小尺寸 = 功能区最简化时的最小尺寸 | `minW` 由紧凑态按钮排布决定；`chromeH_compact` 由紧凑态按钮行高之和决定 |
| 保持媒体内容比例 | 方程里的 `W / ratio_media` 项，且 ratio 有权威来源（见 §4） |
| 手动调整也不能小于最小尺寸 | `minH` 喂给 `NodeResizer` 的 `minWidth/minHeight`，由 system 层 clamp |

**关键推论：`minH` 是算出来的，不是写死的常量。** 同一个节点，9:16 素材的 `minH` 天然比 16:9 大得多。
现在满屏的手写 `minHeight={180}` 正是"用一个常量伺候所有比例"的产物。

---

## 2. 病因（为什么现在会裁）

尺寸的事实源有四个，彼此不知道对方存在：

| 事实源 | 位置 | 它认为节点该多大 |
|---|---|---|
| 新建默认值 | `lib/types.ts` `DEFAULT_NODE_DIMENSIONS` | 手写常量 `video: 320×340` |
| 媒体自适应 | 各节点 `fitNodeToContent()` | 只按媒体比例，**完全不含功能区** |
| 拖拽下限 | 各节点 `<NodeResizer minWidth minHeight>` | 每个视图模式各写一套硬编码 |
| 内容实际下限 | `nodeWrapper(280)` + 固定高元素 | 没人计算，只在运行时被裁掉 |

### 2.1 竖屏视频节点横向被裁（确定性复现）

[VideoGenNode.tsx:217-230](../frontend/components/nodes/VideoGenNode.tsx#L217-L230)，9:16 素材：

```
ratio = 0.5625 → nodeW = clamp(260 × 0.5625, MIN_NODE_W=200, 540) = 200
```

节点宽 200px，而内容根 `nodeWrapper(280)` 声明 `minWidth: 280`
（[PromptNode.tsx:459-468](../frontend/components/nodes/PromptNode.tsx#L459-L468)，CSS 中 `minWidth` 胜过 `maxWidth:100%`）。
→ 内容比节点框宽 80px，header 那排按钮是 `whiteSpace: nowrap`，直接切掉。

按 §3 的清单估算，该 header 完整形态需 **≈ 416px**，是节点宽度的两倍。

### 2.2 设置面板挤扁主体

注释写 `{/* Settings Overlay */}`，实现是**流内块**（[VideoGenNode.tsx:1044](../frontend/components/nodes/VideoGenNode.tsx#L1044)），
和 `flex:1; min-height:0` 的主体抢同一份固定高度。展开后需 400+px，主体被压到 0，面板自身还没有滚动容器。
同样写法见 `ImageGenNode` / `InpaintNode` / `VideoEditNode` / `VideoInterpolateNode` / `VideoUpscaleNode`。

### 2.3 切视图不重算尺寸

VideoGen preview 280×**180** vs editor 280×**240**；VideoEdit 320×**200** vs 320×**260**；ImageGen 240×**160** vs 260×**180**。
从 preview 切回 editor 保持旧高度，必裁。

### 2.4 内容变化不触发尺寸变化

连入第一张参考图（`RefImageStrip` +56px）、报错（`NodeErrorBanner`）、生成中（`GeneratingLine`）都在往固定高度的盒子里塞东西。

### 2.5 `keepAspectRatio` 保不住媒体比例

读 `@xyflow/system@12.10.2` [index.js:3145](../frontend/node_modules/@xyflow/system/dist/esm/index.js#L3145) `getDimensionsAfterResize`：

1. **它锁节点框，不锁媒体区**。`aspectRatio` 取自 `startValues`，即拖拽开始瞬间的 `node.width/node.height`。
   而 `ratio_node = W / (chromeH + W/ratio_media)`，只有 `chromeH = 0` 时才等于 `ratio_media` ——
   节点越小偏得越狠，"保持比例"保住的是一个**随尺寸漂移的错误比例**。
2. **比例没有权威来源**，一旦节点比例错了，它会忠实地把错误保持下去。

目前 8 个节点开着 `keepAspectRatio={true}`：`ImageGen` `Inpaint` `PreviewImage` `Recast` `Style` `Upload` `VideoInterpolate` `VideoUpscale`，全部属于这一类，**应一律弃用**。

同一份源码还确认了两条 API 边界，决定了比例约束**无法插进拖拽循环**：

- `shouldResize` 返回 `false` 只能整帧否决，改不了尺寸；
- `onResize` 在 `onChange` **之前**触发，在其中 `setNodes` 会被立刻覆盖。

---

## 3. "功能区最简化"的定义

三级密度，由节点宽度触发（CSS container query，无 JS 测宽）：

| 密度 | 触发 | 按钮形态 |
|---|---|---|
| `full` | ≥ 380px | 图标 + 文字，全部平铺 |
| `compact` | 280–380px | 次要按钮**只留图标**，标题只留图标 |
| `min` | < 280px | 次要按钮收进 `⋯` 弹出菜单；主操作按钮文案退化 |

**功能不允许消失，只允许简化** —— `⋯` 菜单里仍然点得到。

### VideoGenNode 按钮清单（36 个 `<button>` 中的常驻项）

| 位置 | 按钮 | full | compact | min |
|---|---|---|---|---|
| header | 标题 chip `MiniMax H3 电影镜头` | ≈164px | 图标 24px | 图标 24px |
| header | `🎬 导演台` | 54 | 24 | → `⋯` |
| header | `🎥 运镜`（`directorOwnsPrompt` 时隐藏） | 44 | 24 | → `⋯` |
| header | `🎭 演员` | 44 | 24 | → `⋯` |
| header | `⚡ Latent`（有 latent 时） | 60 | 24 | → `⋯` |
| header | `⚙` 设置 | 20 | 20 | 20 |
| header | `⋯` 溢出菜单 | — | — | 20 |
| 底部 | `SeedControl compact` | 一行 | 一行 | 一行 |
| 底部 | 主操作 `生成 MiniMax H3 电影音视频` | 整宽 | 整宽 | `▶ 生成` |
| 覆盖层 | 播放/静音/截图/下载/重生成/放大 | 图标 | 图标 | 图标 |

header 完整态 ≈ **416px**（含 5 处 gap），紧凑态 ≈ **170px**，`min` 态 ≈ **90px**。
加上节点 `p-3.5` 的左右 28px，`minW` 落在 **≈ 210–220px**。

> **上面所有像素值是按字号与字数估算的，只作 floor 兜底用。真正的 `minW` 在运行时自标定（见 P1）**，
> 否则以后谁改一句按钮文案，常量就悄悄失真了 —— 这正是现在这堆硬编码的下场。

### 由此得到的 chromeH_compact

只数按钮行：`header 30 + SeedControl 22 + 主操作按钮 34 + 节点上下 padding 20` ≈ **106px**。

| 素材比例 | `minH = 106 + minW / ratio`（minW=220） |
|---|---|
| 16:9 | 106 + 124 = **230** |
| 1:1 | 106 + 220 = **326** |
| 9:16 | 106 + 391 = **497** |

提示词编辑器（68px）与参考图条（56px）是内容区，**不进这个式子**（见 §0.1）。
节点拖到 230 高时它们滚动收起，功能按钮与画面完好。

---

## 4. 媒体比例的权威来源

按优先级：

1. 已渲染媒体的自然尺寸 —— `<video>` 的 `onLoadedMetadata` 里读 `videoWidth/videoHeight`，`<img>` 读 `naturalWidth/naturalHeight`。
   **必须用已挂载并渲染的元素**，上传前 new 出来的临时 `<video>` 对不少编码返回 0。
2. `data.width / data.height` —— 即将生成的目标分辨率。
   顺带解决一个投诉：**节点在生成之前就长成成片的形状，生成完不跳变**。
3. 16:9 兜底。

比例变化（改分辨率、换素材）时，**宽度保持不动，只重算高度** —— 这是一自由度模型的直接好处。

---

## 5. 模块设计

### P0 — `lib/nodeSizing.ts`：尺寸方程（新建）

```ts
export interface ChromeMetrics {
  minW: number;     // 紧凑态按钮排布所需的最小宽度
  chromeH: number;  // 紧凑态按钮行高之和
}

export interface NodeSizeSpec {
  minW: number;
  minH: number;     // = chromeH + minW / ratio  ← 算出来的
  chromeH: number;
  ratio: number;
  maxW: number;
}

export function getNodeSizeSpec(
  type: string,
  ratio: number,
  metrics: ChromeMetrics,   // 来自 P1 的自标定，未标定时用 floor 兜底
): NodeSizeSpec;

/** 解方程，不是取 max */
export function solveNodeSize(spec: NodeSizeSpec, width?: number) {
  const w = clamp(width ?? spec.minW, spec.minW, spec.maxW);
  return { width: w, height: Math.round(spec.chromeH + w / spec.ratio) };
}
```

改造后统一由它供给：`DEFAULT_NODE_DIMENSIONS`（改为派生值，保留导出名）、`NodeResizer` 的 min、
各节点的 `fitNodeToContent`、`lib/layoutEngine.ts` 的 `getNodeBounds` 兜底、迁移。
删除各节点的 `CONTENT_BASE_H / MIN_NODE_W / MAX_NODE_W`。

### P1 — `hooks/useChromeMetrics.ts`：minW 运行时自标定（新建）

每个节点类型**只标定一次**，结果存模块级 `Map<nodeType, ChromeMetrics>`：

1. 首次挂载该类型时，在 `position:absolute; visibility:hidden; width:max-content; pointer-events:none`
   的镜像容器里，以 `density='min'` 渲染一份 header 行 + 底部操作行；
2. `ResizeObserver` 读 `scrollWidth` / `offsetHeight` → `{ minW, chromeH }`；
3. 写入缓存，卸载镜像。此后同类型节点直接命中缓存。

好处：改按钮文案、换字体、加一个按钮，`minW` 自动跟着走，不会像现在这样悄悄失真。
未标定时用 §3 的估算值作 floor，首帧不会闪。

### P2 — `components/nodes/NodeShell.tsx`：布局骨架（新建）

五槽，把"谁能压缩、谁不能、谁滚动、谁浮起来"一次性定死：

```tsx
<NodeShell
  spec={spec}
  density={density}          // container query 产出，见 §3
  header={…}                 // 功能区：flex: 0 0 auto
  drawer={showSettings && …} // ★ 流内一行：打开撑高节点，关上还原（见下文，2026-10-04 定）
  media={…}                  // 媒体区：flex: 0 0 auto + aspect-ratio 锁比例
  content={…}                // 内容区：flex: 1 1 auto; min-height: 0; overflow-y: auto —— 原样搬入，不改 JSX
  actions={…}                // 功能区：flex: 0 0 auto，永远可见
  banner={…}
/>
```

槽位样式即 §0.1 的弹性次序：

```css
.shell        { display:flex; flex-direction:column; width:100%; height:100%;
                overflow:hidden; container-type:inline-size; }
.shell-header,
.shell-actions{ flex:0 0 auto; }                      /* 功能区，永不压缩 */
.shell-content{ flex:0 1 auto; min-height:0; overflow-y:auto; }  /* 内容区，先被挤走 */
.shell-media  { flex:1 1 auto; min-height:0; overflow:hidden; }  /* 媒体区，吃掉剩余 */
.shell-media > video,
.shell-media > img { width:100%; height:100%; object-fit:contain; }
```

**媒体区不用 CSS `aspect-ratio`，用"吃掉剩余空间 + `object-fit:contain`"。** 理由见 §5.1：
`aspect-ratio` 会让媒体盒的高度变成宽度的硬函数，拖宽时它撑破容器，等于把 2.1 的裁切换个地方复发。
比例的正确性改由 §5.1 的松手吸附保证：拖拽中最多出现黑边（无害且可见），松手即咬合。

注意 `.shell-content` 是 `flex:0 1 auto`（可缩不可长）而 `.shell-media` 是 `flex:1 1 auto`：
空间不足时先挤内容区（它自己滚动），空间富余时全给画面。

**设置面板（drawer）与可折叠块：打开撑高节点，关上还原。**（2026-10-04 统一，取代早先的绝对定位浮层
和 VideoGenNode 一度用过的"替换主体"写法。）面板是 `.node-shell-drawer`，流内一行、`flex:0 0 auto`、
`max-height:640px` 自带滚动；内容区里能折叠的块标 `data-node-expand`。撑高由谁负责只有一个答案：

- **有媒体**：抽屉是功能区一行（`data-chrome-row="settings"`，进 `activeRows`），折叠块是内容区的一部分，
  都由尺寸方程加进节点高度，关上即按方程收回。
- **没有媒体**：`useNodeSizing` 把 `settings` 行和折叠块从 chromeH / contentH 里剔掉（否则它们会抬高 minH
  或 growToContent 的高度，写进保存尺寸后关不回去），改由 `NodeShell` 量出打开面板的总高
  （`openPanelsHeight`：offsetHeight + 外边距 + 所在 flex 列的一份 gap），临时加到 shell 高度上
  （`calc(100% + extra)`），不写 `node.height`，所以面板开着时自动保存也不会让节点变高。
  打开时手动拖过高度，关上后保留拖出来的高度、只减掉面板。
- **开着设置切换有无媒体**（预览 ↔ 编辑）：有→无时方程已把抽屉算进保存高度，`useNodeSizing` 在
  layout effect 里量出抽屉高，由 `useAutoFitNode` 从保留高度里扣一次；功能区实测值只在对应同一组行时
  才采用，行一变就先用按类型的估算，免得含抽屉的旧值把 minH 抬高、写进保存尺寸。

- **有媒体时打开设置，画面隐藏并暂停**（2026-10-04定）：画面块标 `data-node-media`，`useNodeSizing`
  见到 `settings` 行在场就给 spec 置 `mediaHidden`——方程去掉媒体项，节点 = 功能区（含抽屉）+ 内容；
  `NodeShell` 带 `data-media-hidden`，CSS 隐藏画面块、对其中的 video/audio 调 pause()，播放器也收
  `paused`。关上设置，方程把媒体高度加回来。
- **无媒体时内容装不下**：`NodeShell` 的 editExtra 不再只增不减，每次按内容自然高度精确贴合
  （`contentShortfall`：内容槽解除 flex/height 同步量一次自然高，外加 shell 底部空出的部分），
  只会高于保存尺寸、不会低于。原先切一次视图就留下几百像素空白。

验收量的是 `.node-shell` 的 offsetHeight：关 → 开的增量等于面板高度，再关回到原值（12 个带设置的节点
有媒体、无媒体两种形态都量过）。

`NodeShell` 内层用 `width:100%; height:100%`，**不再设 `minWidth`** —— 宽度下限由 `NodeResizer.minWidth`
在节点层面保证，杜绝"内容比节点框宽"（治 2.1）。根节点加 `container-type: inline-size` 供密度分档。

### P3 — 拖拽约束：弃用 `keepAspectRatio`，松手吸附

```tsx
// ⚠ 两个 useCallback 都是必需的，不是风格问题，理由见下
const handleResizeEnd = useCallback((_, p) => {
  updateNodeData(id, { userWidth: p.width });
  snapToRatio(id, p.width, specRef.current);
}, [id, updateNodeData]);

<NodeResizer
  minWidth={spec.minW}
  minHeight={spec.minH}      // 算出来的，且拖拽期间必须恒定
  maxWidth={spec.maxW}
  keepAspectRatio={false}    // 全部关掉，理由见 2.5
  onResizeEnd={handleResizeEnd}
/>
```

- **有媒体的节点在拖拽过程中就锁死媒体比例**，不是松手才对齐（见 §5.2）；
- 没有媒体的节点自由缩放，方程只守下限；
- `onResizeEnd` 再按 `H(W)` 归一化一次，作为收尾；
- 下限交给 system 层 clamp（已确认 `getSizeClamp` 生效，用户拖不到下限以下）；
- 记 `data.userWidth = p.width`。**一自由度模型下只需记宽度**，`sizeLock` 布尔可以退休。

#### 5.1 两条 ReactFlow 实现约束（读源码确认，踩中即拖拽直接断）

`ResizeControl` 的 `useEffect` 依赖数组含
`[controlPosition, minWidth, minHeight, maxWidth, maxHeight, keepAspectRatio, onResizeStart, onResize, onResizeEnd, shouldResize]`，
且其 cleanup 调用 `resizer.current.destroy()` → `selection.on('.drag', null)`
（[@xyflow/react index.js:4767-4795](../frontend/node_modules/@xyflow/react/dist/esm/index.js#L4767-L4795)）。
即**这十个 prop 中任何一个在拖拽途中变化，都会摘掉 d3 drag handler 并以全新的 `startValues` 重挂**，
表现为拖拽半途中断或尺寸跳变。由此两条硬约束：

1. **`minHeight` 不能是当前宽度的函数。** 想让"高度下限随宽度走"（`minH = chromeH + W/ratio`）
   会在拖宽的每一帧改 `minHeight`，正好踩中上面这条。所以 `minHeight` 只能取一个**与当前宽度无关的稳定下限**：
   `minH = chromeH_compact + minW / ratio`（ratio 变化时才更新，那时没在拖拽）。
   宽度拖大而高度偏矮的中间态，由媒体区留黑边吸收 —— 这正是媒体区不能用 `aspect-ratio` 的原因。
2. **`onResizeEnd` / `onResize` / `shouldResize` 必须 `useCallback`。**
   写成内联箭头函数，每次渲染都是新引用；而拖拽本身就在持续触发节点重渲染 → 第一帧就把 drag handler 摘了。
   同理 `spec` 要用 `useRef` 透传给回调，避免把它也塞进依赖。

> 现有代码没传任何回调，所以今天不会踩到；**这两条是本次改造新引入的雷**，实现时必须遵守。

#### 5.2 拖拽期的等比例约束

要求是"有媒体的节点调整尺寸时按媒体等比例"，而且是**拖拽过程中**就成立。
NodeResizer 给不了这件事，三条路都堵死：

| 尝试 | 为什么不行 |
|---|---|
| `keepAspectRatio` | 锁的是**节点框**比例。节点 = 功能区固定像素带 + 媒体区，锁住 W/H 意味着媒体高 = W·(H₀/W₀) − chromeH，只在拖拽起点那一个宽度上等于 W/ratio，越拖偏得越多（误差趋近 chromeH）。且比例取自起点的 node.width/height，没有权威来源 |
| `onResize` 里 `setNodes` | 该回调跑在 `onChange` **之前**，写进去当场被覆盖 |
| `shouldResize` 返回 false | 只能整帧否决，改不了尺寸 |

可行的切入点在**下游**：resizer 每帧派发的 `dimensions` 变更要经过画布自己的
`onNodesChange`。`constrainResizeChanges()` 在那里按方程改写，逐帧精确，不和拖拽循环抢状态。

它做三件事：

1. **横向拖** → 高度 = `chromeH + 宽度/比例`（宽度是自变量）
2. **纵向拖** → 反解宽度 = `(高度 − chromeH)·比例`，否则上下边手柄拖了没反应
3. **顶边手柄** → resizer 按它自己的高度算过 y（底边不动），高度被改写后 y 要跟着补，
   否则节点会随拖拽上下漂

##### 轴向必须来自 `setAttributes`，不能猜（这条踩过坑）

第一版用"宽度这一帧变没变"来判断是横拖还是纵拖，**会抖**：拖上下边时 resizer 每帧交上来的
宽度恒等于起点宽度，而上一帧我刚把 store 里的宽度反解成了别的值，于是判断在"变了/没变"
之间来回翻，宽度每帧在两个值之间弹。

确定的信号是变更自带的 `setAttributes`（`true` / `'width'` / `'height'`），它由手柄的
`resizeDirection` 决定。但 `NodeResizer` 不暴露 `resizeDirection` —— 所以 `NodeShell` 对
有媒体的节点自己摆一套 `NodeResizeControl`：四角不带轴向、左右边线 `horizontal`、
上下边线 `vertical`。没有媒体的节点仍用现成的 `NodeResizer`。

还有一处：改写后必须把 `setAttributes` 置为 `true`。`applyNodeChanges` 用它决定写不写
width/height（[index.js:691](../frontend/node_modules/@xyflow/react/dist/esm/index.js#L691)），
留着 `'height'` 的话反解出来的宽度会被直接丢掉。

spec 通过一个模块级注册表跨到画布：`useNodeSizing` 登记，卸载时注销 ——
`onNodesChange` 在组件作用域之外，拿不到各节点算出来的 spec。

因为比例每帧都是精确的，`object-contain` 在拖拽中也不会再出现黑边了。

### P4 — `hooks/useAutoFitNode.ts`：自愈（新建）

替换各节点那段 `useEffect + setNodes` 样板：

```ts
useAutoFitNode(id, spec, { deps: [viewMode, ratio, status] });
```

- 写回 **top-level `node.width` / `node.height`**，不是 `node.style.width`
  （ReactFlow v12：`ResizeObserver` 一旦写过 `node.width`，`style.width` 就被忽略）；
- 宽度取 `data.userWidth ?? defaultW(type)`（舒适默认值，不是 `minW`），高度永远由方程算 —— 用户的宽度不会被系统改掉；
- `deps` 变化（尤其 `viewMode`、`ratio`）触发重算，治 2.3 / 2.4。

### P5 — 兜底与迁移

- **溢出角标**：`NodeShell` 检测 `content.scrollHeight > clientHeight` → 右下角 `⌄` 角标，点击 = 适配内容；
- **`⤢` 适配内容**：selected 时出现，一次调到 `solveNodeSize(spec)` 并清 `data.userWidth`；双击 resizer 手柄同效；
- **`migrateNodeSizes(nodes)`** 加进已有的 `lib/migrations.ts` 迁移链：老工程打开时按新方程重算，**只抬不降**。

---

## 6. 落地顺序（已全部完成）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | `nodeSizing.ts` + `NodeShell` + `useChromeMetrics` + `useAutoFitNode`，接入 `VideoGenNode` | ✅ |
| 2 | 关掉 8 处 `keepAspectRatio`，接 `onResizeEnd` 吸附 | ✅ |
| 3 | 其余 13 个节点接入 shell，设置面板改抽屉 | ✅ |
| 4 | `useAutoFitNode` 取代各节点的 `fitNodeToContent` | ✅ |
| 5 | 密度分档 + 溢出角标 + 双击适配 + `migrateNodeSizes` | ✅ |

## 7. 验收用例

- [ ] 9:16 竖屏视频生成完 → header 按钮完整可见（或以 `⋯` 形态可达），无横向溢出
- [ ] 把任一节点拖到最小 → 所有功能按钮仍**可达**，主操作按钮完整可点；内容区滚动收起而非被裁
- [ ] 拖宽有媒体的节点 → **拖拽全程**媒体区无黑边、不裁边，节点比例始终 = 媒体比例
- [ ] 拖上下边手柄 → 节点跟着变（宽度被反解），不是纹丝不动
- [ ] 拖顶边手柄 → 底边不动，节点不上下漂
- [ ] 拖没有媒体的节点（提示词、编辑态）→ 宽高自由，不被比例绑住
- [ ] **拖拽全程不中断、不跳变**（验证 §5.1 两条约束都遵守了）
- [ ] 展开 ⚙ 设置 → 主体不被压缩，面板内部滚动，8 个运镜 + 5 个画幅 chip 全可见
- [ ] preview ⇄ editor 来回切 → 两侧都不裁
- [ ] 改按钮文案后重启 → `minW` 自动跟随，无需改常量
- [ ] 手动拖宽 → 生成新视频 / 改分辨率后宽度不变，只有高度按新比例变
- [ ] 打开旧工程 → 所有节点尺寸 ≥ 新下限，位置不变
- [ ] 内容区（提示词框、参考图条）的 JSX 一行未改，行为与改造前一致


---

## 8. 实现记录

### 8.1 落地文件

| 文件 | 作用 |
|---|---|
| `frontend/lib/nodeSizing.ts` | 尺寸方程与 spec。取代 14 个节点里的 `CONTENT_BASE_H / MIN_NODE_W / MAX_NODE_W` |
| `frontend/lib/nodeSizing.test.ts` | 方程的不变量测试（13 条） |
| `frontend/hooks/useChromeMetrics.ts` | 功能区最小尺寸的运行时逐行就地标定 |
| `frontend/hooks/useAutoFitNode.ts` | 尺寸自愈 + `snapNodeToRatio` 松手吸附 |
| `frontend/hooks/useNodeSizing.ts` | 一站式接线，每个节点一次调用 |
| `frontend/components/nodes/NodeShell.tsx` | 布局骨架、统一 NodeResizer、溢出角标、双击适配 |
| `frontend/app/globals.css` | 槽位弹性、抽屉浮层、密度容器查询、测量类、角标 |
| `frontend/lib/migrations.ts` | `migrateNodeSizes`：旧工程打开时抬到新下限 |
| `frontend/lib/types.ts` | `SizedNodeData` 基类，15 个节点数据接口共用 `userWidth` |
| 14 个节点组件 | 全部接入 |

改造后全仓库：`nodeWrapper` 已删除、`fitNodeToContent` 归零、`keepAspectRatio` 只剩 NodeShell 里那一处 `false`、旧尺寸常量归零。

### 8.2 实现中被修正的设计

**(a) 比例项只在画面在场时成立 —— `spec.hasMedia`**

原设计默认每个节点都有媒体区。但 H3 节点的**编辑态根本没有画面**，整块是控件与文本。
按 `chromeH + W/ratio` 给它算高度的后果：

| | 修正前 | 修正后 |
|---|---|---|
| 16:9 编辑态 | 320×285 | 保留现有高度，minH 226 |
| 9:16 编辑态 | 320×**675**，minH=**500** 拖不小 | 保留现有高度，minH 226 |

无媒体时高度归内容管，方程只守下限；`useAutoFitNode` 与 `snapNodeToRatio` 此时都只 clamp。
`prompt` / `videoEdit` 编辑态 / `scene` 出图前 / `videoInterpolate` 无源片时都走这一档。

**(b) 功能区必须逐行标定**

同一个节点的不同视图在场的行不一样：H3 预览态只有标题栏（画面满铺、无内边距），
编辑态还有底部 seed 与生成按钮加 `p-3.5`。拿一个总高去套预览态会**多算 60 多像素**，画面永远差一截。
改成 `rows: ['header', 'actions']` 逐行量，节点按当前视图 `chromeHeightFor(['header'])` 点名。
行高连 `margin` 一起算 —— 标题条靠 `marginBottom` 拉开距离，漏掉少 8px。

**(c) 标定方式：镜像渲染 → 就地测量**

阶段 1 的做法是把 header/actions 抽成变量、在隐藏镜像里再渲染一遍。推到 14 个节点上，
等于每个节点都要先做一次 JSX 抽取，还把同一棵子树渲染两次。
改为**就地测量**：`useLayoutEffect` 里给节点根临时加 `.node-chrome-measuring`
（强制图标态 + `width:max-content`），读 `scrollWidth` 与行高后同帧摘掉，绘制前已还原。
没量到的行（当前视图没渲染）留到渲染它的视图挂载时补，结果按类型累积。

**(d) 密度是全有或全无，而且由实测决定，不设断点**

功能区只有两种形态：**完整文案，或只留图标**。中间态一律不允许 ——
折行（"编辑提示词"被压成两行）、省略号、横向滚动，都是把问题推给用户。

一开始用容器查询在 380px 分档。那个数字是拍脑袋的：按钮个数与文案随时会改，
写死的断点必然失真（正是被换掉的那批 `minWidth={280}` 的下场）。
改为 `NodeShell` 实测：先摘掉 compact 量一次自然宽度，`scrollWidth > clientWidth` 就整排收成图标态，
节点拖宽后文案自动展开。容器查询与 `container-type` 一并退休。

配套的 CSS 约束：节点内所有按钮 `white-space: nowrap` 且 `flex-shrink: 0` —— flex 子项默认
可以被压到 min-content，那正是文案折行的来源。

`minW` 是按图标态标定的，所以图标态永远放得下，不需要 `⋯` 溢出菜单：功能不会消失，只是文字让位。

**(e) 内容区的"标记"与"弹性"要解耦**

`.node-shell-content` 带着 `flex:0 1 auto`（先被挤走）。但编辑态那些本该 `flex-1` 生长的区域
贴上这个类会被改坏布局。于是分成两种写法：需要"先被挤走"的用类名，只需要被溢出检测认出来的
用 `data-shell-content`。

### 8.3 顺带修掉的坑

- **`useAutoFitNode` 里宽度是黏着的**：`userWidth ?? n.width ?? defaultW`。中间那档不能省 ——
  老工程的节点没有 `userWidth`，少了它一打开就被推回默认宽度，用户之前拖的尺寸全丢。
- **依赖数组不能用 `...deps` 展开**：内部依赖一加项，热更新当场报
  "changed size between renders"。改成把 deps 折成一个定长 key。
- **主媒体区从 `object-cover` 改为 `object-contain`**：cover 会裁掉画面边缘，
  跟"保持媒体比例"直接矛盾。有了 §5.2 的逐帧约束，节点比例始终等于媒体比例，两者等价 ——
  contain 只是保证任何时刻都不裁画面。缩略图与虚化背景保持 cover，它们是装饰。
- **`PoseNode` 往 `n.style.width/height` 写的尺寸同步早就失效**（v12 里 `node.width`
  一旦被写过，`style.width` 就被忽略），改由 `ratioSources` + 宽度跟随接管。
- 节点的 resize 手柄现在环绕**整个节点**（含标题栏），而不是只环绕卡片主体。

### 8.4 验证

`tsc --noEmit` 与 `next build` 干净；`npm test` 156 项全过（新增 24 项：方程不变量 13、拖拽约束 11）；
dev server 热更新后运行时无报错。**未做**：无头浏览器不可用，交互与视觉需人工点验（见 §7）。
