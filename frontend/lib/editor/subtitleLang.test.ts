import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { timelineToSrt } from './srt';
import {
  referenceTitle, importSrtAsLang, languageProgress, parseSrt, removeSubtitleLang, setTitleIn, subtitleLangsOf, switchSubtitleLang,
} from './subtitleLang';
import { defaultClip, type Timeline } from './types';

const title = (id: string, start: number, length: number, content: string, extra: object = {}) =>
  defaultClip({
    id, trackId: 'SUB_1', assetId: '', start, inFrame: 0, outFrame: length,
    text: { content } as never, ...extra,
  });

const film = (clips: ReturnType<typeof title>[]): Timeline =>
  ({ fps: 24, width: 1920, height: 1080, tracks: [], clips, assets: {} });

const base = () => film([title('a', 0, 24, 'Hello'), title('b', 48, 24, 'Goodbye')]);

describe('subtitle languages', () => {
  it('keeps the old words when the language changes, and brings them back', () => {
    const zh = importSrtAsLang(base(), 'zh', parseSrt('1\n00:00:00,000 --> 00:00:01,000\n你好\n\n2\n00:00:02,000 --> 00:00:03,000\n再见\n')).timeline;
    const onZh = switchSubtitleLang(zh, 'zh');
    assert.deepEqual(onZh.clips.map((c) => c.text!.content), ['你好', '再见']);
    assert.equal(onZh.subtitleLang, 'zh');
    const back = switchSubtitleLang(onZh, 'en');
    assert.deepEqual(back.clips.map((c) => c.text!.content), ['Hello', 'Goodbye']);
    assert.deepEqual(back.clips.map((c) => c.text!.i18n), [{ zh: '你好' }, { zh: '再见' }]);
  });

  it('shows nothing for a title with no words in the new language, and exports the rest', () => {
    const half = setTitleIn(base(), 'a', 'zh', '你好');
    const onZh = switchSubtitleLang(half, 'zh');
    assert.equal(onZh.clips[1].text!.content, '');
    assert.equal(timelineToSrt(onZh), '1\n00:00:00,000 --> 00:00:01,000\n你好\n');
    assert.deepEqual(languageProgress(onZh, 'zh'), { done: 1, total: 2 });
    assert.deepEqual(languageProgress(onZh, 'en'), { done: 2, total: 2 });
  });

  it('pairs an SRT with the same number of cues by order, even if the times moved', () => {
    const out = importSrtAsLang(base(), 'zh', parseSrt('1\n00:00:00,500 --> 00:00:01,500\n你好\n\n2\n00:00:09,000 --> 00:00:10,000\n再见\n'));
    assert.equal(out.matched, 2);
    assert.equal(out.timeline.clips[1].text!.i18n!.zh, '再见');
  });

  it('pairs by overlap when the counts differ, and reports what did not fit', () => {
    const out = importSrtAsLang(base(), 'zh', parseSrt('1\n00:00:02,000 --> 00:00:03,000\n再见\n\n2\n00:00:20,000 --> 00:00:21,000\n多余\n\n3\n00:00:30,000 --> 00:00:31,000\n也多余\n'));
    assert.equal(out.matched, 1);
    assert.equal(out.unmatched, 1);
    assert.equal(out.spare, 2);
    assert.equal(out.timeline.clips[0].text!.i18n?.zh, '');
    assert.equal(out.timeline.clips[1].text!.i18n!.zh, '再见');
  });

  it('writes into content when the language being imported is the current one', () => {
    const out = importSrtAsLang(base(), 'en', parseSrt('1\n00:00:00,000 --> 00:00:01,000\nHi\n\n2\n00:00:02,000 --> 00:00:03,000\nBye\n'));
    assert.deepEqual(out.timeline.clips.map((c) => c.text!.content), ['Hi', 'Bye']);
  });

  it('lists the current language first and can drop another', () => {
    const t = switchSubtitleLang(setTitleIn(base(), 'a', 'zh', '你好'), 'zh');
    assert.deepEqual(subtitleLangsOf(t), ['zh', 'en']);
    const dropped = removeSubtitleLang(t, 'en');
    assert.deepEqual(subtitleLangsOf(dropped), ['zh']);
    assert.equal(dropped.clips[0].text!.i18n, undefined);
    assert.equal(removeSubtitleLang(t, 'zh'), t);
  });

  it('parses BOM, CRLF and dot milliseconds', () => {
    const cues = parseSrt('﻿1\r\n00:00:01.5 --> 00:00:02.000\r\n第一行\r\n第二行\r\n\r\n');
    assert.deepEqual(cues, [{ start: 1.5, end: 2, text: '第一行\n第二行' }]);
  });

  it('offers the first language as a reference for an untranslated title only', () => {
    const onZh = switchSubtitleLang(setTitleIn(base(), 'a', 'zh', '你好'), 'zh');
    assert.equal(referenceTitle(onZh, onZh.clips[0]), '');
    assert.equal(referenceTitle(onZh, onZh.clips[1]), 'Goodbye');
    assert.equal(referenceTitle(base(), base().clips[0]), '');
  });
});
