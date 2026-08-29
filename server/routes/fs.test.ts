import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homeDir, defaultDownloadDir, safeDir } from './fs.ts';
import { HttpError } from '../http.ts';

// safeDir 是这个 dev server 唯一的写入边界：前端传来的字符串会变成 mkdir 的参数。
// 它放行什么、拒绝什么全部钉在这里。
//
// 用真实家目录而不是 mock：边界本身就是 os.homedir()，换成假路径就测不到
// realpath / 相对路径展开这两条真正容易写错的规则。

const home = homeDir();

/** 断言抛的是 400 而不是 500 —— 500 会把内部报错文案漏给前端 */
function reject(input: unknown, hint: string): void {
  assert.throws(
    () => safeDir(input as string),
    (error: unknown) => {
      assert.ok(error instanceof HttpError, `${hint}: 应该抛 HttpError`);
      assert.equal(error.status, 400, hint);
      return true;
    },
    hint,
  );
}

describe('homeDir / defaultDownloadDir', () => {
  it('家目录是解过符号链接的绝对路径', () => {
    assert.ok(path.isAbsolute(home));
    assert.equal(home, fs.realpathSync(home));
  });

  it('默认下载目录落在家目录里', () => {
    assert.equal(defaultDownloadDir(), path.join(home, 'Music', 'luoyun'));
  });
});

describe('safeDir 放行', () => {
  it('相对路径按家目录展开，不是按 cwd', () => {
    // 按 cwd 展开的话 destDir: "server" 会把音频写进项目仓库、触发 Vite 重启
    assert.equal(safeDir('luoyun-测试-不存在/x'), path.join(home, 'luoyun-测试-不存在', 'x'));
  });

  it('展开 ~ 和 ~/', () => {
    assert.equal(safeDir('~'), home);
    assert.equal(safeDir('~/Music/luoyun-测试-不存在'), path.join(home, 'Music', 'luoyun-测试-不存在'));
  });

  it('去掉首尾空白', () => {
    assert.equal(safeDir('  ~/luoyun-测试-不存在  '), path.join(home, 'luoyun-测试-不存在'));
  });

  it('家目录本身可以', () => {
    assert.equal(safeDir(home), home);
  });

  it('以 .. 开头的正经目录名不算逃逸', () => {
    // 前缀判断必须精确到路径分隔符，否则家目录下一个叫 "..foo" 的目录会被误拒
    assert.equal(safeDir('..foo'), path.join(home, '..foo'));
  });
});

describe('safeDir 拒绝', () => {
  it('空目录', () => {
    reject('', '空串');
    reject('   ', '全空白');
    reject('~/..', '指回家目录的上一层');
  });

  it('非字符串（body 里塞个数字过来）不能变成 500', () => {
    reject(123, '数字');
    reject(null, 'null');
    reject(undefined, 'undefined');
    reject({}, '对象');
  });

  it('家目录外的绝对路径', () => {
    reject('/etc', '/etc');
    reject('/', '根目录');
    reject(path.join(home, '..'), '家目录的父目录');
  });

  it('.. 逃逸', () => {
    reject('../..', '相对逃逸');
    reject('~/../..', '~ 之后再逃逸');
    reject('Music/../../../etc', '中间夹 ..');
  });
});

describe('safeDir 符号链接', () => {
  // 唯一需要动文件系统的一组：链接必须真的存在，realpathSync 才会解它。
  // 建在家目录里（隐藏名），跑完就删。
  const sandbox = fs.mkdtempSync(path.join(home, '.luoyun-test-'));
  after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  it('指向家目录外的链接要拒绝', () => {
    // path.resolve 是纯字符串运算，不认符号链接：
    // 少了 realpath，家目录里一个 ~/tmp -> /private/tmp 就能写到家目录外面去
    const link = path.join(sandbox, 'escape');
    fs.symlinkSync(path.parse(home).root, link);
    reject(link, '指向根目录的链接');
    reject(path.join(link, 'etc'), '穿过链接再往下');
  });

  it('指向家目录内部的链接放行，并解析成真实路径', () => {
    const target = path.join(sandbox, 'real');
    fs.mkdirSync(target);
    const link = path.join(sandbox, 'inside');
    fs.symlinkSync(target, link);
    assert.equal(safeDir(link), target);
  });
});
