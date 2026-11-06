import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeStoredFile } from '../src/stored-files.js';

const failWith = code => async () => { throw Object.assign(new Error(code), { code }); };
async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-stored-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, target: path.join(dir, 'a', 'file.txt') };
}

for (const code of ['EPERM', 'ENOSYS', 'EXDEV', 'ENOTSUP', 'EISDIR']) {
  test(`without hard links (${code}) a file is still stored whole, and no temporary file stays`, async t => {
    const { target } = await folder(t);
    t.mock.method(fs, 'link', failWith(code));
    await writeStoredFile(target, 'bytes');
    assert.equal(await fs.readFile(target, 'utf8'), 'bytes');
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['file.txt']);
    await writeStoredFile(target, Buffer.from('bytes'));
    await assert.rejects(writeStoredFile(target, 'different'), error => error.statusCode === 409);
    assert.equal(await fs.readFile(target, 'utf8'), 'bytes', 'an existing file is never replaced');
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['file.txt']);
  });
}

test('without hard links a failed publish leaves nothing at the final name', async t => {
  const { target } = await folder(t);
  t.mock.method(fs, 'link', failWith('EPERM'));
  t.mock.method(fs, 'rename', failWith('ENOSPC'));
  await assert.rejects(writeStoredFile(target, 'bytes'), error => error.code === 'ENOSPC');
  assert.deepEqual(await fs.readdir(path.dirname(target)), []);
});

test('without hard links a different file arriving in the rename window is reported, not accepted', async t => {
  const { target } = await folder(t);
  t.mock.method(fs, 'link', failWith('ENOTSUP'));
  t.mock.method(fs, 'rename', async () => { await fs.writeFile(target, 'other'); });
  await assert.rejects(writeStoredFile(target, 'bytes'), error => error.statusCode === 409);
});

test('any other link failure is still an error', async t => {
  const { target } = await folder(t);
  t.mock.method(fs, 'link', failWith('EACCES'));
  await assert.rejects(writeStoredFile(target, 'bytes'), error => error.code === 'EACCES');
  assert.deepEqual(await fs.readdir(path.dirname(target)), []);
});
