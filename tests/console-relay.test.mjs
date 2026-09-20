import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConsoleRelay} from '../app/console-relay.mjs';
import {deflateSync} from 'node:zlib';

test('compressed history is restored exactly and oversized expansion is rejected', async()=>{
  const body={goal:'hello',transcript:'package output '.repeat(2000)};
  const plans=[], reports=[];
  const relay=new ConsoleRelay(async value=>{plans.push(value);return {explanation:'Hi',command:''};},async()=>{},text=>reports.push(text));
  const packet=value=>({id:'compressed',seq:0,encoding:'deflate',chunk:deflateSync(JSON.stringify(value)).toString('base64'),end:true});
  await relay.feed(packet(body));
  assert.deepEqual(plans,[body]);
  await relay.feed(packet({transcript:'x'.repeat(100000)}));
  assert.equal(plans.length,1);
  assert.match(reports.at(-1),/too large/);
});

test('acknowledges each request chunk before starting AI and supports consecutive turns', async()=>{
  const acks=[], planned=[], replies=[];
  const relay=new ConsoleRelay(async body=>{planned.push(body);return {explanation:'ok',command:''};},async p=>replies.push(p),()=>{},async p=>acks.push(p));
  for (let turn=0;turn<3;turn++) {
    const encoded=Buffer.from(JSON.stringify({goal:'turn '+turn,transcript:'x'.repeat(20000)})).toString('base64');
    for (let offset=0,seq=0;offset<encoded.length;offset+=768,seq++) {
      await relay.feed({id:String(turn),seq,chunk:encoded.slice(offset,offset+768),end:offset+768>=encoded.length,flow:'ack'});
      assert.deepEqual(acks.at(-1),{id:String(turn),seq});
    }
    assert.equal(planned.length,turn+1);
    assert.equal(relay.pending.size,0);
  }
  assert.equal(replies.length,3);
});

test('computer prompts are relayed without executing proposals on phone', async()=>{
  const replies=[];
  const body={goal:'Install with café hostname',transcript:'output',conversation:[]};
  const relay=new ConsoleRelay(async value=>{assert.deepEqual(value,body);return {explanation:'Hello',command:'echo test'};},async packet=>replies.push(packet),()=>{});
  const encoded=Buffer.from(JSON.stringify(body)).toString('base64');
  await relay.feed({id:'console',type:'chat_request',seq:0,chunk:encoded.slice(0,20),end:false});
  assert.equal(replies.length,0);
  await relay.feed({id:'console',type:'chat_request',seq:1,chunk:encoded.slice(20),end:true});
  assert.deepEqual(JSON.parse(Buffer.from(replies.map(p=>p.chunk).join(''),'base64')), {explanation:'Hello',command:'echo test'});
  assert.equal(replies.at(-1).end,true);
});

test('disconnection discards an in-flight reply and provider failures reach the console', async()=>{
  const sent=[]; let finish;
  const packet={id:'test',seq:0,chunk:Buffer.from('{"goal":"hi"}').toString('base64'),end:true};
  const relay=new ConsoleRelay(()=>new Promise(resolve=>finish=resolve),async p=>sent.push(p),()=>{});
  const work=relay.feed(packet);
  relay.reset(); finish({explanation:'late',command:'echo late'}); await work;
  assert.equal(sent.length,0);
  relay.plan=async()=>{throw new Error('Phone busy');};
  await relay.feed(packet);
  assert.equal(JSON.parse(Buffer.from(sent[0].chunk,'base64')).error,'Phone busy');
});
