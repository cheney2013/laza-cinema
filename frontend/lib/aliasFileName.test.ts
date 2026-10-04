import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { aliasFileName } from './utils';

describe('aliasFileName', () => {
  it('names the file after the alias and keeps the extension', () => {
    assert.equal(aliasFileName('场1 · 推近 v2', '/comfy_output/H3_Video_ab_00001_.mp4'), '场1 · 推近 v2.mp4');
    assert.equal(aliasFileName('定妆', '/uploads/sheet.png?x=1'), '定妆.png');
  });

  it('replaces characters file systems refuse', () => {
    assert.equal(aliasFileName('a/b:c*?"<>|d\\e', '/x.wav'), 'a_b_c_d_e.wav');
  });

  it('does not double an extension the alias already has', () => {
    assert.equal(aliasFileName('片段.mp4', '/x.mp4'), '片段.mp4');
  });

  it('gives nothing for an empty alias, so the server name is used', () => {
    assert.equal(aliasFileName('   ', '/x.mp4'), null);
    assert.equal(aliasFileName(undefined, '/x.mp4'), null);
  });
});
