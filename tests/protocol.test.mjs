import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frame,Frames} from '../app/protocol.mjs';
test('fragmented BLE chunks preserve UTF-8 and consecutive messages', () => {
  const received = [], decoder = new Frames(value => received.push(value));
  const bytes = new Uint8Array([...frame({id:'a',data:'hello 🌱'}),...frame({id:'b',type:'exit',code:0})]);
  for (const byte of bytes) decoder.feed([byte]);
  assert.deepEqual(received,[{id:'a',data:'hello 🌱'},{id:'b',type:'exit',code:0}]);
});
test('oversized and invalid frames fail explicitly', () => {
  assert.throws(() => frame({data:'x'.repeat(2048)}),/limit/);
  assert.throws(() => new Frames(()=>{}).feed(new Uint8Array(2049).fill(65)),/limit/);
  assert.throws(() => new Frames(()=>{}).feed(new TextEncoder().encode('[]\n')),/Invalid/);
});
