import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UUID, Frames, frame} from '../app/protocol.mjs';

test('phone demo requires review, streams results, cancels, and disconnects', async () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      value:'', textContent:'', checked:false, hidden:false, disabled:false,
      classList:{toggle(){}}, listeners:{},
      addEventListener(event, callback) { this.listeners[event] = callback; },
      showModal() { this.open = true; },
      close(value) { this.open = false; this.returnValue = value; },
      replaceChildren(...items) { this.children = items; },
      append(item) { (this.children ||= []).push(item); },
      setAttribute() {},
    });
    return elements.get(id);
  };
  globalThis.document = {getElementById:get, querySelectorAll:()=>[], createElement:()=>({value:'',textContent:''})};
  let recognition;
  globalThis.SpeechRecognition = class {
    constructor() { recognition = this; }
    start() {}
    stop() { this.onend(); }
  };
  get('timeout').value = '120';
  await import('../app/app.js');
  assert.equal(get('run').disabled, true);
  get('demo').onclick();
  assert.equal(get('mode').textContent, 'DEMO');
  get('command').value = 'lsblk --json';
  await get('run').onclick();
  assert.equal(get('review').open, true);
  assert.equal(get('review-command').textContent, 'lsblk --json');
  assert.doesNotMatch(get('output').textContent, /Running/);
  get('review').returnValue = 'cancel';
  await get('review').listeners.close();
  assert.doesNotMatch(get('output').textContent, /Running/);
  await get('run').onclick();
  get('ack').checked = true;
  get('review').returnValue = 'run';
  await get('review').listeners.close();
  assert.equal(get('run').disabled, true);
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.match(get('output').textContent, /Example SSD/);
  assert.match(get('output').textContent, /Exit 0/);
  assert.equal(get('run').disabled, false);
  await get('run').onclick();
  get('ack').checked = true;
  await get('review').listeners.close();
  await get('cancel').onclick();
  assert.match(get('output').textContent, /cancelled/);
  assert.equal(get('cancel').disabled, true);
  await get('arch-inspect').onclick();
  assert.match(get('output').textContent, /lsblk --json --paths/);
  assert.equal(get('arch-next').disabled, true);
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(get('arch-disk').children.length, 2); // placeholder + internal SSD; excludes USB.
  assert.equal(get('arch-next').disabled, false);
  get('arch-disk').value = '/dev/nvme0n1';
  await get('arch-next').onclick();
  assert.match(get('arch-status').textContent, /exactly/);
  get('arch-confirm').value = '/dev/nvme0n1'; get('arch-erase').checked = true;
  const beforeSuggestion = get('output').textContent;
  await get('arch-next').onclick();
  assert.match(get('chat').children.at(-1).textContent, /Install automatically/);
  assert.equal(get('proposal-run').hidden, true);
  assert.equal(get('output').textContent, beforeSuggestion); // Asking never executes.
  assert.equal(get('auto-start').disabled, false);
  // Fast test bypasses the typed path, checkbox and command modal.
  get('fast-test').checked = true; get('fast-test').onchange();
  assert.equal(get('disk-confirmation').hidden, true);
  get('arch-confirm').value = ''; get('arch-erase').checked = false;
  await get('arch-next').onclick();
  assert.match(get('arch-status').textContent, /Erasure authorized/);
  get('review').open = false;
  get('command').value = 'echo fast';
  await get('run').onclick();
  assert.equal(get('review').open, false);
  assert.match(get('output').textContent, /echo fast/);
  assert.equal(get('cancel').disabled, false);
  await get('cancel').onclick();
  get('disconnect').onclick();
  assert.equal(get('mode').textContent, 'OFFLINE');
  assert.equal(get('session').hidden, true);
  assert.equal(get('run').disabled, true);
  assert.equal(get('arch-next').disabled, true);
  assert.equal(get('arch-erase').checked, false);
  let requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return {ok:false, json:async()=>({error:'AI temporarily unavailable after three attempts.'})};
  };
  get('goal').value = 'Install KDE';
  await get('ask').onclick();
  assert.equal(get('retry').hidden, false);
  assert.equal(get('command').value, '');
  assert.equal(get('proposal-run').hidden, true);
  const messagesBeforeRetry = get('chat').children.length;
  globalThis.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return {ok:true, json:async()=>({explanation:'Which timezone?',command:''})};
  };
  await get('retry').onclick();
  assert.equal(requests[0].goal, requests[1].goal);
  assert.equal(get('chat').children.length, messagesBeforeRetry + 1);
  assert.equal(get('retry').hidden, true);
  get('mic').onclick();
  const result = [{transcript:'America New York'}]; result.isFinal = true;
  recognition.onresult({results:[result]});
  assert.equal(get('goal').value, 'America New York');
  assert.equal(requests.length, 2); // Dictation never sends or executes.
  recognition.onend();
  get('goal').value = 'UTC';
  await get('ask').onclick();
  assert.deepEqual(requests[2].conversation.map(item=>item.content), ['Install KDE','Which timezone?']);

  // Bluetooth connects before the bridge is ready; Inspect must recover.
  let notification, onDisconnect, pingCount = 0, environmentReply;
  const executions = [], notices = [], keys = [];
  const send = message => {
    const bytes = frame(message);
    notification({target:{value:new DataView(bytes.buffer)}});
  };
  const wire = new Frames(message => {
    if (message.op === 'device') send({id:message.id,type:'device'});
    if (message.op === 'key') { keys.push(message.key); send({id:message.id,type:'key'}); }
    if (message.op === 'ping') {
      if (message.chat_notice) notices.push(message.chat_notice);
      pingCount++;
      send(pingCount === 1
        ? {id:message.id,type:'error',message:'Bridge not running yet'}
        : {id:message.id,type:'ready',protocol:1,root:true,environment:environmentReply});
    }
    if (message.op === 'exec') {
      executions.push(message.command);
      send({id:message.id,type:'stdout',data:JSON.stringify({blockdevices:[{name:'/dev/vda',size:'20G',type:'disk',mountpoints:[null],tran:'virtio'}]})});
      send({id:message.id,type:'exit',code:0,reason:'completed'});
    }
  });
  const rx = {writeValueWithResponse:async bytes => wire.feed(bytes)};
  const tx = {addEventListener:(name, fn)=>{notification=fn;},startNotifications:async()=>{}};
  const service = {getCharacteristic:async uuid=>uuid === UUID.rx ? rx : tx};
  const device = {addEventListener:(name, fn)=>{onDisconnect=fn;},gatt:{
    connect:async()=>({getPrimaryService:async()=>service}),disconnect:()=>onDisconnect()}};
  globalThis.window = {isSecureContext:true};
  Object.defineProperty(navigator, 'bluetooth', {value:{requestDevice:async()=>device}, configurable:true});
  await get('connect').onclick();
  assert.equal(get('mode').textContent, 'BLUETOOTH CONNECTED');
  assert.equal(get('session').hidden, false);
  assert.equal(get('arch-inspect').disabled, false);
  assert.match(get('arch-status').textContent, /bridge did not respond/);
  assert.equal(get('run').disabled, true);
  await get('arch-inspect').onclick();
  assert.equal(pingCount, 2);
  assert.equal(get('mode').textContent, 'LINUX READY');
  assert.equal(get('arch-disk').children[1].value, '/dev/vda');
  assert.equal(get('arch-next').disabled, false);
  get('arch-disk').value = '/dev/vda';
  await get('arch-next').onclick();
  const automaticRequests = [];
  globalThis.fetch = async (url, options) => {
    automaticRequests.push(JSON.parse(options.body));
    return {ok:true, json:async()=>automaticRequests.length === 1
      ? {explanation:'Verify target',command:'echo verify-test',state:'User requested KDE and UTC. Verification pending.',status:'working'}
      : {explanation:'Test verification finished',command:'',state:'Test verification succeeded',status:'complete'}};
  };
  await get('auto-start').onclick();
  await new Promise(resolve=>setTimeout(resolve,550));
  assert.equal(automaticRequests.length, 2);
  assert.equal(executions.at(-1), 'echo verify-test');
  assert.match(automaticRequests[1].installation_context.saved_state, /KDE and UTC/);
  assert.ok(automaticRequests[1].installation_context.user_answers.includes('UTC'));
  assert.match(automaticRequests[1].transcript, /echo verify-test/);
  assert.equal(get('auto-pause').hidden, true);
  assert.ok(notices.includes('Verify target'));
  assert.ok(notices.some(text=>text.includes('Step finished')));
  // Pausing while an AI request is in flight discards the late command.
  let resolveProposal;
  globalThis.fetch = async()=>({ok:true,json:()=>new Promise(resolve=>{resolveProposal=resolve;})});
  await get('auto-start').onclick();
  await new Promise(resolve=>setTimeout(resolve,200));
  const beforePause = executions.length;
  get('auto-pause').onclick();
  resolveProposal({explanation:'Late',command:'echo must-not-run',state:'',status:'working'});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(executions.length, beforePause);
  get('assistant-mode').value = 'troubleshoot';
  await get('assistant-mode').onchange();
  assert.equal(keys.at(-1),'CTRL_ALT_F3');
  assert.equal(get('assistant-mode').value,'troubleshoot');
  const shortcutCount = keys.length;
  await get('troubleshoot').onclick();
  assert.equal(keys.length,shortcutCount+1);
  assert.equal(get('disk-options').hidden, true);
  // A ready bridge does not need the local console setup buttons.
  assert.equal(get('mount-arch-card').hidden, true);
  const troubleRequests=[];
  globalThis.fetch = async (url, options) => {
    troubleRequests.push(JSON.parse(options.body));
    return {ok:true,json:async()=>troubleRequests.length < 3
      ? {explanation:'Inspect and verify the network',command:'echo network-check',state:'Network task',status:'working'}
      : {explanation:'Network verified',command:'',state:'Network verified',status:'complete'}};
  };
  get('goal').value = 'Check my network';
  await get('ask').onclick();
  await new Promise(resolve=>setTimeout(resolve,550));
  assert.equal(troubleRequests.length,3);
  assert.equal(troubleRequests[0].installation_context.mode,'troubleshoot');
  assert.equal(troubleRequests[0].installation_context.authorized_disk,null);
  assert.equal(troubleRequests[0].installation_context.automatic,true);
  assert.deepEqual(troubleRequests[0].installation_context.user_answers,['Check my network']);
  assert.equal(executions.slice(-2).every(command=>command === 'echo network-check'),true);
  assert.match(get('auto-status').textContent,/Task complete/);
  globalThis.fetch = async()=>({ok:true,json:async()=>({explanation:'Doing well, thanks!',command:'',state:'',status:'conversation'})});
  const beforeGreeting = executions.length;
  get('goal').value = 'How are you?'; await get('ask').onclick();
  assert.equal(executions.length,beforeGreeting);
  get('disconnect').onclick();
  environmentReply = {default_mode:'troubleshoot',os:'linux',shell:'bash',live:false};
  await get('connect').onclick();
  assert.equal(get('assistant-mode').value,'troubleshoot');
  assert.equal(get('disk-options').hidden,true);
  get('disconnect').onclick();
});
