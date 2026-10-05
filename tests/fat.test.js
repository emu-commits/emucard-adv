import test from 'node:test';
import assert from 'node:assert/strict';
import { FatVolume, formatImage, FatError } from '../src/fat.js';

const MB = 1024 * 1024;
const text = (s) => new TextEncoder().encode(s);
const str = (b) => new TextDecoder().decode(b);

test('formats FAT16 cards of common sizes', () => {
  for (const mb of [16, 32, 64, 256, 1024]) {
    const v = new FatVolume(formatImage(mb * MB));
    assert.equal(v.type, 16, `${mb} MB`);
    assert.equal(v.label, 'CARDPUTER');
    assert.deepEqual(v.list('/'), []);
    assert.ok(v.freeBytes > mb * MB * 0.98);
  }
});

test('formats FAT32 above 2 GiB', () => {
  const v = new FatVolume(formatImage(4096 * MB));
  assert.equal(v.type, 32);
  v.writeFile('/a/b.txt', text('fat32'));
  assert.equal(str(v.readFile('/a/b.txt')), 'fat32');
});

test('writes, reads, replaces and deletes files with long names', () => {
  const v = new FatVolume(formatImage(32 * MB));
  v.writeFile('/hello.txt', text('hello'));
  v.writeFile('/My Programs/a rather long file name.rb', text('puts 1'));
  v.writeFile('/Area512_data/home/user/.ti-loader.manifest', text('m'));
  assert.equal(str(v.readFile('/HELLO.TXT')), 'hello', 'names are case-insensitive');
  assert.equal(str(v.readFile('/My Programs/a rather long file name.rb')), 'puts 1');
  assert.deepEqual(v.list('/Area512_data/home/user').map((e) => e.name), ['.ti-loader.manifest']);
  v.writeFile('/hello.txt', text('replaced, and longer than before'));
  assert.equal(str(v.readFile('/hello.txt')), 'replaced, and longer than before');
  const before = v.freeBytes;
  v.remove('/My Programs');
  assert.ok(v.freeBytes > before);
  assert.equal(v.exists('/My Programs/a rather long file name.rb'), false);
  assert.deepEqual(v.list('/').map((e) => e.name).sort(), ['Area512_data', 'hello.txt']);
});

test('files spanning many clusters survive a round trip', () => {
  const v = new FatVolume(formatImage(16 * MB));
  const big = new Uint8Array(3 * MB + 123);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 9)) & 0xff;
  v.writeFile('/big.bin', big);
  assert.deepEqual(v.readFile('/big.bin'), big);
});

test('short-name collisions get numeric tails', () => {
  const v = new FatVolume(formatImage(16 * MB));
  for (let i = 0; i < 30; i++) v.writeFile(`/dir/long name number ${i}.txt`, text(String(i)));
  for (let i = 0; i < 30; i++) assert.equal(str(v.readFile(`/dir/long name number ${i}.txt`)), String(i));
  assert.equal(v.list('/dir').length, 30);
});

test('directories grow past one cluster', () => {
  const v = new FatVolume(formatImage(16 * MB));
  for (let i = 0; i < 200; i++) v.writeFile(`/many/f${i}.txt`, text('x'));
  assert.equal(v.list('/many').length, 200);
});

test('a full card is reported, not corrupted', () => {
  const v = new FatVolume(formatImage(16 * MB));
  assert.throws(() => v.writeFile('/too-big.bin', new Uint8Array(17 * MB)), FatError);
  assert.deepEqual(v.list('/'), []);
});

test('reads a card behind an MBR partition table', () => {
  const vol = formatImage(16 * MB);
  const disk = new Uint8Array(17 * MB);
  disk.set(vol, MB);
  const p = 446;
  disk[p + 4] = 0x06;
  new DataView(disk.buffer).setUint32(p + 8, MB / 512, true);
  new DataView(disk.buffer).setUint32(p + 12, vol.length / 512, true);
  disk[510] = 0x55; disk[511] = 0xaa;
  const v = new FatVolume(disk);
  v.writeFile('/x.txt', text('mbr'));
  assert.equal(str(new FatVolume(disk).readFile('/x.txt')), 'mbr');
});
