/**
 * H3 提示词手册的内容表。纯数据，不经过 t()：这里的英文是要原样写进提示词的词汇，
 * 中文说明只是给写提示词的人看的，不是界面文案（i18n 覆盖率检查只看 t() 调用）。
 *
 * 来源：
 * - 运镜词表：MiniMax 官方《Video Prompt Writing Guide》§4.3（base-en）
 * - 台词内标签：r/StableDiffusion 帖 "Pushing AI emotions is possible through..."（2026-09），社区实测
 * - 链式规则：本项目《最后生还者》场1 实测（docs/H3_PRODUCTION_LINE.md 与 memory）
 */

export interface HelpRow {
  term: string;
  meaning: string;
  example?: string;
}

export interface HelpSection {
  id: string;
  title: string;
  intro?: string;
  rows?: HelpRow[];
  bullets?: string[];
  columns?: [string, string, string?];
}

export const H3_HELP_SECTIONS: HelpSection[] = [
  {
    id: 'structure',
    title: '提示词结构（Ref2VA 六段式）',
    intro: '带参考图的生成一律六段，顺序不能换，字段名原样：',
    rows: [
      { term: 'subject_definitions:', meaning: '每张图、每段音一条。<Picture N> 按接线顺序编号；人物用 <Subject N> 指向定妆板；写清"哪些部分不进画面"（灰底、拼板格）。' },
      { term: 'summary:', meaning: '≤70 词，只写场景设定和分镜清单，不写剧情动作（写了演员会抢演后面镜头的内容）。' },
      { term: 'retention_analysis:', meaning: '每个标签一行：fully_preserved / partially_preserved / weak_reference / reference（音频）。房间板通常 fully；灰模构图锚要 partially 才压得住。' },
      { term: 'detailed_description:', meaning: '一句风格开场 + [Shot N] 块。正文 ≤500 词，加一句就删一句。' },
      { term: 'overall_soundscape:', meaning: '环境声和动作声。要声音在场写 close-miked / clearly audible，写 soft/faint 会渲成死底噪。' },
      { term: 'non_diegetic_music:', meaning: '没有就 N/A。' },
    ],
    columns: ['字段', '写法'],
  },
  {
    id: 'shots',
    title: '镜头块与切点',
    bullets: [
      '[Shot 1] 开头先声明起始静态终态（上一镜结束时的姿势），再写动作；不要用 "has just / is starting" 这类过程动词开头。',
      '切镜写法：[Shot 2] At 00:05.500, the shot cuts to … 。时间码只在切点位置是官方用法；镜内时间码（At 00:02.000 …）在带参考图的链路上也起作用，但模型通常提前约 0.5 s。',
      '只描述画框内的东西。提到画框外的物件、人、过程，它就会被画进来。',
      '不写否定句（"绝不要出现 X"会把 X 钉进画面）；同一物件一镜只点名一次、一种状态。',
      '持续动作要写时间节拍：两个时间戳 + 一句静止，否则"转半圈"会转到 400°。',
      '画面文字必须逐字放进英文双引号，≤40 字符。',
      '接触类动作要拆成可观察的步骤，别写结果。戴表："lays the watch face up on the top of his left wrist, wraps the long end of the strap under the wrist and up through the buckle, pushes the pin through a hole, and tucks the free end under the keeper loop"（探针 04c4327e 实测不穿模）；写成 "puts it on and buckles it" 表带会直接穿过手。测这类写法用 tools/h3_probe.py 批量出 5 秒 T2VA。',
    ],
  },
  {
    id: 'camera',
    title: '运镜词表（官方 §4.3）',
    intro: '写成镜头里的自然英语动作："The camera pushes in with small amplitude at slow speed toward the letter."，不要堆在句尾当标签。幅度/速度是中档时省略。',
    columns: ['词', '含义', '例句'],
    rows: [
      { term: 'Zoom In / Zoom Out', meaning: '机身不动，焦距变', example: 'The camera zooms in slowly on her hands.' },
      { term: 'Push In / Pull Out', meaning: '机身前进 / 后退', example: 'The camera pushes in with small amplitude at slow speed.' },
      { term: 'Pan Left / Pan Right', meaning: '机位不动，镜头水平转', example: 'The camera pans left with her as she kneels.' },
      { term: 'Truck Left / Truck Right', meaning: '机身水平平移', example: 'The camera trucks left alongside him down the corridor.' },
      { term: 'Tilt Up / Tilt Down', meaning: '机位不动，镜头上下转', example: 'The camera tilts down to the box on his thigh.' },
      { term: 'Pedestal Up / Pedestal Down', meaning: '整机升 / 降', example: 'The camera pedestals up a little into a high angle.' },
      { term: 'Arc Shot', meaning: '绕主体弧线移动', example: 'The camera arcs slowly around the two of them.' },
      { term: 'Tracking Shot', meaning: '跟随运动主体', example: 'The camera tracks her along the sofa.' },
      { term: 'Static Shot', meaning: '机位和镜头都不动', example: 'The camera holds a static shot.' },
      { term: 'Shake Slightly / Shake Strongly', meaning: '轻微 / 强烈晃动（手持）', example: 'The camera shakes slightly with small amplitude at slow speed for the whole shot, as a handheld camera does.' },
      { term: 'POV', meaning: '主观视角', example: 'A POV shot from where she sits.' },
      { term: 'Roll Clockwise / Roll Counterclockwise', meaning: '绕光轴滚转', example: 'The camera rolls clockwise a few degrees.' },
      { term: 'with small / large amplitude', meaning: '幅度', example: 'pans right with large amplitude' },
      { term: 'at slow / fast speed', meaning: '速度', example: 'pushes in at slow speed' },
    ],
  },
  {
    id: 'dialogue',
    title: '台词与表演',
    intro: '格式：<角色描述>, <delivery 情绪/语速> (S1), says: <d>[English] 逐字台词</d>。情绪写在 <d> 外的 delivery 里；delivery 一两个准词比堆一串形容词有效（"quiet and moved" 比 "exhausted, sagging, trailing off" 出来的疲惫感更对）。',
    bullets: [
      '语言标签可带修饰：[English, crying] / [English, singing] / [Hum]。语速靠 delivery 字段（"blurting it out extremely fast, the whole line run together"），[English, rushed] 无效，<gasp> 反而插进 1.7 s 的吸气把句子拖慢（2026-09-10 实测）。',
      '有台词的镜头会被多分时间，代价是同一支里没台词的镜头被压缩；要表演的镜头写台词，要延续背景的镜头别和台词放同一支。',
      '一镜里放了和讲话冲突的拍子（眨眼、吞咽）会被吃掉；讲完话之后的拍子放到下一镜。',
    ],
  },
  {
    id: 'tags',
    title: '台词内表演标签（<d> 里生效，社区实测）',
    intro: '标签直接放在 <d>…</d> 的台词文本里，作用在语音时间轴上。官方指南没写这些，是 r/StableDiffusion 帖子的实测表；本项目 2026-09-10 起在链 6–9 试用。',
    columns: ['标签', '作用', '例子'],
    rows: [
      { term: '<pause>', meaning: '短停顿', example: 'Okay, so. <pause> This is just me talking.' },
      { term: '<long pause>', meaning: '长停顿', example: 'I mean... <long pause> I don\'t even know.' },
      { term: '<breath>', meaning: '呼吸声', example: 'And then... <breath> it just happened.' },
      { term: '<inhale> / <exhale>', meaning: '吸气 / 呼气', example: '<inhale> Alright, let\'s do this.' },
      { term: '<catches breath>', meaning: '喘不上气', example: 'Wait... <catches breath> hold on a sec.' },
      { term: '<deep breath>', meaning: '深呼吸平复', example: '<deep breath> Okay. I can do this.' },
      { term: '<i>word</i>', meaning: '强调 1–4 个词', example: 'I was <i>not</i> expecting that.' },
      { term: '<whisper>…</whisper>', meaning: '耳语', example: '<whisper> Don\'t tell anyone this.</whisper>' },
      { term: '<softer>', meaning: '压低音量', example: '<softer> I don\'t think I can say it.' },
      { term: '<laughs> / <chuckle>', meaning: '笑 / 轻笑', example: 'That\'s... <laughs> that\'s actually funny.' },
      { term: '<sighs>', meaning: '叹气', example: '<sighs> I really tried.' },
      { term: '<uh>', meaning: '填充词、迟疑', example: 'So, like... <uh> what was I saying?' },
      { term: '<stutter>', meaning: '结巴', example: '<stutter> I ca can\'t believe that.' },
      { term: '<gasp>', meaning: '倒吸一口气', example: '<gasp> Oh my God.' },
      { term: '<coughs> / <clears throat>', meaning: '咳嗽 / 清嗓', example: '<clears throat> So anyway...' },
      { term: '<sniff>', meaning: '吸鼻子', example: '<sniff> It\'s just... really sad.' },
      { term: '<smacks lips></smacks lips>', meaning: '咂嘴（不闭合会落在句尾）', example: '<smacks lips></smacks lips> Okay.' },
      { term: '<pant> / <pants>', meaning: '喘气', example: 'Run... <pants> run now!' },
      { term: '<humming>…</humming>', meaning: '哼唱', example: '<humming> da-da-da-beautiful-day.</humming>' },
      { term: '<mhm> / <phew>', meaning: '应和 / 松口气', example: '<phew> That was close.' },
    ],
  },
  {
    id: 'chain',
    title: '链式生成（Motion Context）实测规则',
    intro: '链上每段 = 参考图 + 上一段潜变量。潜变量只带最后 22 帧的运动和画面状态；身份、服装、陈设仍由参考图钉，所以每个节点的参考边都要接全。',
    bullets: [
      '【标准流程】链段开场按官方写法，不拆 Shot：[Shot 1] 从上一段末帧的真实构图和动作直接写下去。两段式（[Shot 1] 静默 + [Shot 2] At 00:01.000 no cut）已停用：链5同 seed 对照，两段式在接缝后把动作一下推进约一秒，不拆 Shot 的版本第 0 帧和上一段末帧几乎一致，台词也没吞。渲完仍用 faster-whisper 逐词核首句。',
      '开头 22 帧是重生成的接缝。首帧图不再作为吞台词的对策：首帧图接的链第 0 帧整体暗 2–3 色阶。首句仍被吞时，才考虑把首句挪到上一段结尾画外说。',
      '【检查点】参考音频接进画布前先归一化到约 -20 LUFS（两遍 loudnorm，另存新文件名）：H3 照着参考音频的音量出声，链4挂了 -33.5 LUFS 的电话声，整段只有 -35 LUFS，比链5小 15 LU。每段渲完和 Whisper 一起量整段响度（ebur128 的 I 值），和前后链差超过约 3 LU 就查。',
      '[Shot 1] 要写上一段末帧的真实构图和人物位置，别照抄提示词原来的机位：链5重接时上下文 22 帧接上了，但 Shot 1 写的是中景双人，第 0 帧直接跳成了那个机位。',
      '【拼接流程】motion context 的上下文帧是重生成的，硬接在裁切点会轻微跳（链1→2 接缝 37.9 dB，平常相邻帧 45–48，换 seed 不变）。成片拼接一律做 22 帧交叉淡化：链的潜变量存着完整跨度，用 tools/h3_decode_latent.py 解码出上下文头，让上一段最后 22 帧淡进去（assemble_scene1.py 的 XFADE）。高清同样解码超分潜变量，不用重新超分。上一段被裁短、或接缝本身是硬切的不做。',
      '接缝处换机位要在片内声明硬切：[Shot 1] 接上一段半秒，[Shot 2] At 00:00.500, the shot cuts to …。不声明，模型会延续上一段的机位。',
      '机位状态会继承：上一段静机，这一段写 handheld / Shake Slightly 都无效；手持要在链头定，链头没有上下文，听提示词。',
      '风格（低调光、颗粒、对比）同理只能在链头定，中段加风格词几乎无效（同 seed 逐帧一样）。带人的照片级"曝光基准图"会把它的服装和背景漏进来，不要用。',
      '灰模构图锚：独立 <Picture N>，写明蓝块=谁、橙块=谁、脸板朝向；retention 用 partially_preserved（weak_reference 压不过房间板）。人物朝向要用脸板标，别放会误导朝向的手臂块。',
      '同一 seed 改数字（停留 0.5 s、机位再近一点）推不动时换 seed 抽样，构图差异比改词大得多。',
      '上游任何一段改动，下游全部重跑；一组链 3–4 段，在换光源/换空间处断开另起。',
      '后端重启会 interrupt ComfyUI 正在跑的任务（它把状态文件里的任务当孤儿）。渲染中别跑 start.ps1，别改 backend/ 下会触发重载的东西。',
    ],
  },
  {
    id: 'checks',
    title: '验收',
    bullets: [
      'python tools/check_h3_prompt.py <prompt.txt>：六段齐全、词数、否定词、时间码、运镜幅度、声音强度。',
      '每 12 帧一格通看全片；切点实测（均值 + 2.6σ 帧差），不按名义帧读首帧。',
      '每次接链渲完都用 faster-whisper 逐词转写核对第一句是否完整（缺头的首句转写常被听成别的词，如 You kept complaining → Complain in the back）。',
      '台词用 faster-whisper 转写核对，逐词时间戳量语速；哈欠、吸鼻子会被识别成词，0–6 s 出现莫名台词先看音频能量。',
      '手持是否生效看背景区域的逐帧位移，不看主体。',
      '表情有没有发生：抽"该动之前/之后"两帧算 PSNR，>40 dB 等于没动。',
    ],
  },
];
