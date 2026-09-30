#!/usr/bin/env node
/**
 * find-extension.js — 定位 Chrome/Edge 里已安装的本插件目录
 *
 * 原理：从 Preferences 的 extensions.settings 里读 path。
 * （Chrome 正在运行时 Preferences 可能被锁，先复制副本再读）
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TARGET_KEY = 'B站听歌追踪器';

const PROFILES = [
  ['Chrome', 'C:/Users/Public/AppData/Local/Google/Chrome/User Data'],
  ['Edge', 'C:/Users/Public/AppData/Local/Microsoft/Edge/User Data']
];

function tmpCopy(src) {
  const dst = path.join(os.tmpdir(), 'pref-' + Date.now() + '-' + path.basename(src));
  fs.copyFileSync(src, dst);
  return dst;
}

for (const [name, ud] of PROFILES) {
  console.log('\n════════ ' + name + ' ════════');
  if (!fs.existsSync(ud)) { console.log('  配置目录不存在'); continue; }

  const dirs = fs.readdirSync(ud, { withFileTypes: true })
    .filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
    .map(d => d.name);

  for (const prof of dirs) {
    const prefPath = path.join(ud, prof, 'Preferences');
    if (!fs.existsSync(prefPath)) continue;

    let pref;
    try {
      pref = JSON.parse(fs.readFileSync(tmpCopy(prefPath), 'utf8'));
    } catch (e) {
      console.log('  [' + prof + '] 读取 Preferences 失败: ' + e.message);
      continue;
    }

    const settings = (pref.extensions && pref.extensions.settings) || {};
    const hits = [];
    for (const [id, s] of Object.entries(settings)) {
      const blob = JSON.stringify(s.manifest || {}) + ' ' + (s.path || '');
      if (blob.indexOf(TARGET_KEY) >= 0 || blob.indexOf('BiliMusicTracker') >= 0 ||
          (s.path || '').indexOf('bili-music-tracker') >= 0) {
        hits.push({ id, path: s.path, name: (s.manifest && s.manifest.name) || '?',
          version: (s.manifest && s.manifest.version) || '?',
          state: s.state, location: s.location, installTime: s.install_time });
      }
    }

    if (hits.length) {
      console.log('  [' + prof + '] 找到 ' + hits.length + ' 个匹配:');
      for (const h of hits) {
        console.log('    ID       : ' + h.id);
        console.log('    名称     : ' + h.name + '  v' + h.version);
        console.log('    state    : ' + h.state + '   location=' + h.location + '  (1=用户自装)');
        console.log('    源目录   : ' + h.path);
        if (h.path && fs.existsSync(h.path)) {
          const files = fs.readdirSync(h.path);
          console.log('    目录内容 : ' + files.join(', '));
          const cj = path.join(h.path, 'src', 'content.js');
          if (fs.existsSync(cj)) {
            const st = fs.statSync(cj);
            console.log('    content.js 大小=' + st.size + ' 修改时间=' + st.mtime.toISOString());
          }
        } else {
          console.log('    （目录不存在或无权访问）');
        }
      }
    } else {
      console.log('  [' + prof + '] 未找到匹配的扩展');
    }
  }
}
