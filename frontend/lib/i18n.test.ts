import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_LOCALE, matchLocale, phaseKey, pickLocale, translate } from './i18n';

describe('浏览器语言 → 界面语言', () => {
  it('主子标签匹配，地区和文字变体都忽略', () => {
    assert.equal(matchLocale('ja'), 'ja');
    assert.equal(matchLocale('ja-JP'), 'ja');
    assert.equal(matchLocale('JA-jp'), 'ja');
    assert.equal(matchLocale('zh-TW'), 'zh');
    assert.equal(matchLocale('zh-Hans-CN'), 'zh');
  });

  it('没有的语言返回 null，由调用方决定退到哪', () => {
    assert.equal(matchLocale('en-US'), null);
    assert.equal(matchLocale('ko'), null);
    assert.equal(matchLocale(''), null);
  });

  it('按浏览器的偏好顺序取第一个有的语言，而不是直接退到默认', () => {
    assert.equal(pickLocale(['en-US', 'ja-JP', 'zh-CN']), 'ja');
    assert.equal(pickLocale(['zh-CN', 'ja']), 'zh');
  });

  it('一个都没有就中文', () => {
    assert.equal(pickLocale(['en-US', 'ko-KR']), 'zh');
    assert.equal(pickLocale([]), 'zh');
    assert.equal(DEFAULT_LOCALE, 'zh');
  });
});

describe('查词', () => {
  it('字典里没有的条目原样退回中文，不会露出裸键', () => {
    assert.equal(translate('ja', '这条没翻译'), '这条没翻译');
    assert.equal(translate('zh', '退出登录'), '退出登录');
    assert.equal(translate('ja', '退出登录'), 'ログアウト');
  });

  it('占位符按名字填，语序可以和中文不同', () => {
    assert.equal(translate('ja', '已登录：{name}', { name: 'cy' }), 'ログイン中：cy');
    assert.equal(translate('zh', '已登录：{name}', { name: 'cy' }), '已登录：cy');
  });
});

describe('后端推来的进度阶段', () => {
  const ja = (phase: string) => {
    const { key, vars } = phaseKey(phase);
    return translate('ja', key, vars);
  };

  it('固定文案直接查字典', () => {
    assert.equal(ja('正在连接渲染引擎…'), 'レンダリングエンジンに接続中…');
    assert.equal(ja('已提交至渲染队列，等待启动…'),
      'レンダリングキューに送信しました。開始待ちです…');
    assert.equal(ja('正在准备素材与构建工作流…'), '素材を準備し、ワークフローを構築中…');
  });

  it('带数字的两条把数字提出来再查，否则永远查不到', () => {
    assert.equal(ja('扩散去噪采样中 (7/8)'), 'ノイズ除去サンプリング中（7/8）');
    assert.equal(ja('分段生成 2/5'), '分割生成 2/5');
  });

  it('没见过的阶段原样退回，不会露出裸键', () => {
    assert.equal(ja('某个新阶段'), '某个新阶段');
    assert.equal(phaseKey('某个新阶段').key, '某个新阶段');
  });
});
