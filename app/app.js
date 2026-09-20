import {UUID, frame, Frames} from './protocol.mjs';
import {INSPECT_ARCH, inventory} from './arch-setup.mjs';
import {InstallAgent, installRequest, selectTestDisk} from './agent.mjs';
import {ConsoleRelay} from './console-relay.mjs';
const agent = new InstallAgent();
let autoTimer;
let pendingInstallGoal = null;
const $ = id => document.getElementById(id);
let device, rx, tx, demo = false, ready = false, active = null, log = '', connecting = false;
const nativeBLE = globalThis.AndroidBLE;
let nativeConnect = null;
let writes = Promise.resolve(), timer, demoTimer, pendingReview, generation = 0;
const pending = new Map();
const parser = () => new Frames(receive);
let frames = parser();
let aiAuthRequired = true;
let archDisks = [], archInspection = '', commandOutput = '', activeCommand = '', aiBusy = false;
const archHistory = [];
const conversation = [];
let approvedDisk = null, retryGoal = null;
let checkingBridge = false;
let assistantMode = 'install', modeChosen = false, bridgeEnvironment = {};
let openingTerminal = false;
const troubleshooting = () => assistantMode === 'troubleshoot';
const fastTest = () => !troubleshooting() && $('fast-test').checked;
function setAssistantMode(mode) {
  if (!['install','troubleshoot'].includes(mode)) throw new Error('Unknown mode');
  if (active || aiBusy || agent.running) { $('assistant-mode').value = assistantMode; throw new Error('Pause and finish the current operation before switching modes.'); }
  assistantMode = mode; $('assistant-mode').value = mode;
  agent.reset(); approvedDisk = null; retryGoal = null; pendingInstallGoal = null; pendingReview = null;
  conversation.length = 0; archHistory.length = 0; archDisks = []; archInspection = ''; log = '';
  $('chat').replaceChildren(); $('output').textContent = ''; $('command').value = '';
  $('proposal-run').hidden = $('continue').hidden = $('retry').hidden = true;
  if ($('review').open) $('review').close('cancel');
  $('auto-status').textContent = troubleshooting() ? 'Describe the problem or task. I’ll inspect, act, and check the result, with updates here.' : 'Select a disk to install Arch using your preferences or basic defaults.';
  chat('assistant', troubleshooting() ? 'What would you like me to fix or do on this computer?' : 'What would you like for your Arch installation?');
  update();
}
const consoleRelay = new ConsoleRelay(async body => {
  if (aiBusy || active || agent.running) throw new Error('The phone installer is busy. Pause it before using computer chat.');
  const consoleMode = body.installation_context?.mode;
  if (['install','troubleshoot'].includes(consoleMode) && consoleMode !== assistantMode) {
    setAssistantMode(consoleMode); modeChosen = true;
  }
  aiBusy = true; update();
  try {
    if (!body.installation_context?.automatic) chat('user', body.goal);
    const response = await fetch('/api/plan', {method:'POST',headers:aiHeaders(),body:JSON.stringify(body),signal:AbortSignal.timeout(65000)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'AI request failed');
    chat('assistant', result.explanation);
    return result;
  } finally { aiBusy = false; update(); }
}, packet => request('ping', {chat_reply:packet}), status,
   packet => request('ping', {chat_received:packet}));
function chat(role, content) {
  const bubble = document.createElement('div');
  bubble.className = `message ${role}`;
  bubble.textContent = `${role === 'user' ? 'You' : 'LinuxLink'}: ${content}`;
  $('chat').append(bubble); $('chat').scrollTop = $('chat').scrollHeight;
}
function remember(role, content) {
  conversation.push({role, content:content.slice(0,6000)});
  while (conversation.length > 40 || JSON.stringify(conversation).length > 20000) conversation.shift();
  chat(role, content);
  if (role === 'assistant' && ready && !demo) {
    void shareUpdate(content).catch(error=>status(`Computer update could not be delivered: ${error.message}`));
  }
}
function progress(text) {
  chat('assistant', text);
  if (ready && !demo) void shareUpdate(text).catch(error=>status(error.message));
}
let updateWrites = Promise.resolve();
function shareUpdate(text) {
  const current = generation;
  const send = async () => {
    // Keep every frame below the ESP32's 2048-byte input limit, including Unicode.
    const characters = Array.from(text.slice(0,6000));
    for (let offset = 0; offset < characters.length; offset += 300) {
      if (current !== generation) return;
      await request('ping', {chat_notice:characters.slice(offset, offset+300).join('')});
    }
  };
  const result = updateWrites.then(send);
  updateWrites = result.catch(()=>{});
  return result;
}
function aiHeaders() {
  const headers = {'Content-Type':'application/json','X-LinuxLink-Client':'web'};
  if (aiAuthRequired) headers.Authorization = `Bearer ${$('token').value}`;
  return headers;
}
function append(text) { log = (log + text).slice(-128000); $('output').textContent = log; $('output').scrollTop = $('output').scrollHeight; }
function status(text) { $('status').textContent = text; }
function update() {
  const connected = demo || !!rx;
  $('session').hidden = !connected;
  $('mount-arch-card').hidden = !troubleshooting() || ready;
  $('start-arch-bridge').hidden = !troubleshooting() || ready;
  $('test-typing').hidden = !troubleshooting();
  $('install-mode').hidden = !troubleshooting();
  $('test-typing').disabled = (!demo && !rx) || connecting || !!active || aiBusy || agent.running || checkingBridge || openingTerminal;
  $('mount-arch-card').disabled = (!demo && !rx) || connecting || !!active || aiBusy || agent.running || checkingBridge || openingTerminal;
  $('start-arch-bridge').disabled = (!demo && !rx) || connecting || !!active || aiBusy || agent.running || checkingBridge || openingTerminal;
  $('install-mode').disabled = !!active || aiBusy || agent.running || checkingBridge || openingTerminal;
  $('troubleshoot').disabled = (!demo && !rx) || connecting || !!active || aiBusy || agent.running || checkingBridge;
  $('assistant-mode').disabled = !!active || aiBusy || agent.running || checkingBridge;
  $('disk-options').hidden = troubleshooting();
  $('fast-test').parentElement && ($('fast-test').parentElement.hidden = troubleshooting());
  $('auto-start').textContent = troubleshooting() ? 'Resume task' : 'Install automatically';
  $('auto-pause').textContent = 'Pause';
  $('mode-help').textContent = troubleshooting() ? 'Use your existing Arch system with the LinuxLink bridge installed. Describe a problem or task below.' : 'Install Arch from the bootable microSD.';
  $('goal').placeholder = troubleshooting() ? 'My Wi-Fi stopped working. Can you fix it?' : 'Help me install Arch with a desktop...';
  $('mode').textContent = demo ? 'DEMO' : connected ? ready ? 'LINUX READY' : 'BLUETOOTH CONNECTED' : 'OFFLINE';
  $('dot').classList.toggle('online', connected);
  $('connect').hidden = $('demo').hidden = connected;
  $('connect').disabled = $('demo').disabled = connecting;
  $('disconnect').hidden = !connected;
  $('ping').disabled = !connected || checkingBridge || !!active;
  $('run').disabled = !ready || !!active || aiBusy || checkingBridge;
  $('ask').disabled = !!active || aiBusy || checkingBridge;
  $('proposal-run').disabled = !ready || !!active || aiBusy || checkingBridge;
  $('retry').disabled = $('continue').disabled = !!active || aiBusy || checkingBridge;
  $('cancel').hidden = !active;
  $('arch-inspect').disabled = !connected || connecting || checkingBridge || !!active || aiBusy;
  $('arch-inspect').textContent = checkingBridge ? 'Checking Linux bridge...' : 'Inspect computer';
  $('arch-next').disabled = !ready || checkingBridge || !!active || aiBusy || !archDisks.length;
  $('disk-confirmation').hidden = fastTest();
  $('arch-next').textContent = fastTest() ? 'Use this disk (erase allowed)' : 'Confirm disk';
  $('proposal-run').textContent = troubleshooting() ? 'Review step' : fastTest() ? 'Run installation step' : 'Review installation step';
  $('run').textContent = fastTest() ? 'Run command' : 'Review & run';
  $('fast-test').disabled = !!active || aiBusy || checkingBridge;
  $('auto-start').disabled = !ready || (troubleshooting() ? !agent.answers.length : !approvedDisk) || !!active || aiBusy || checkingBridge || agent.running;
  $('auto-pause').hidden = !agent.running;
  $('arch-disk').disabled = agent.running || !!active || aiBusy;
  if (agent.running) {
    $('auto-status').textContent = troubleshooting() ? `Working on your task. Step ${agent.steps}.` : `Installing on ${approvedDisk}. Step ${agent.steps}. Progress and recovery steps run automatically.`;
    for (const id of ['ask','run','proposal-run','continue','retry','arch-inspect','arch-next','fast-test']) $(id).disabled = true;
  }
  $('cancel').disabled = !active;
  if (openingTerminal) for (const id of ['troubleshoot','assistant-mode','ask','run','proposal-run','continue','retry','arch-inspect','arch-next','auto-start']) $(id).disabled = true;
  document.querySelectorAll('[data-key]').forEach(button => button.disabled = !connected || !!active);
}
function disconnected() {
  modeChosen = false; bridgeEnvironment = {};
  pendingInstallGoal = null;
  consoleRelay.reset();
  clearTimeout(autoTimer); agent.reset();
  $('auto-status').textContent = 'Automatic installation stopped on disconnect. Inspect the computer before resuming; command outcome may be unknown.';
  generation++;
  checkingBridge = false;
  approvedDisk = null; retryGoal = null; conversation.length = 0;
  $('chat').replaceChildren();
  chat('assistant', 'Connection ended. Reconnect and inspect the computer before continuing.');
  $('proposal-run').hidden = $('continue').hidden = $('retry').hidden = true;
  $('command').value = '';
  pendingReview = null;
  if ($('review').open) $('review').close('cancel');
  rx = tx = null; demo = ready = false; frames = parser();
  clearTimeout(timer); clearTimeout(demoTimer);
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Device disconnected.')); }
  pending.clear();
  if (active) append('\n[Connection lost. Command outcome is unknown; do not automatically repeat it.]\n');
  active = null;
  archDisks = []; archInspection = ''; archHistory.length = 0;
  $('arch-erase').checked = false; $('arch-confirm').value = ''; $('arch-disk').value = '';
  $('arch-status').textContent = 'Connection ended. Inspect the computer again before continuing installation.';
  status('Disconnected. Reconnect and check the computer before continuing.'); update();
}
function receive(message) {
  if (message.type === 'chat_update') { chat('assistant', message.text); return; }
  if (message.type === 'chat_request') { void consoleRelay.feed(message); return; }
  const waiter = pending.get(message.id);
  if (waiter) {
    clearTimeout(waiter.timer); pending.delete(message.id);
    if (message.type === 'error') waiter.reject(new Error(message.message)); else waiter.resolve(message);
  }
  if (message.id !== active) return;
  if (message.type === 'stdout' || message.type === 'stderr') {
    append(message.data || '');
    if (message.type === 'stdout') commandOutput = (commandOutput + (message.data || '')).slice(0, 16000);
  }
  else if (message.type === 'started') append('[Running]\n');
  else if (message.type === 'exit' || message.type === 'error') {
    append(message.type === 'exit' ? `\n[Exit ${message.code} · ${message.reason}]\n` : `\n[Error: ${message.message}]\n`);
    archHistory.push({command:activeCommand,code:message.code,reason:message.reason || message.message});
    if (archHistory.length > 100) archHistory.shift();
    if (activeCommand === INSPECT_ARCH) {
      try {
        if (message.type !== 'exit' || message.code !== 0 || message.reason !== 'completed' && message.reason !== 'demo') throw new Error('Inspection failed. Check the output and run it again.');
        archDisks = inventory(commandOutput); archInspection = commandOutput;
        if (!archDisks.some(disk => disk.name === approvedDisk)) {
          approvedDisk = null;
          if (agent.running) pauseAutomatic('Disk authorization needs checking. Inspect the current mounts before continuing.');
        }
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a disk to erase';
        const options = archDisks.map(disk => {
          const option = document.createElement('option'); option.value = disk.name;
          option.textContent = `${disk.name} — ${disk.size} — ${disk.model || 'Unknown model'}`;
          return option;
        });
        $('arch-disk').replaceChildren(placeholder, ...options);
        $('arch-status').textContent = archDisks.length ? 'Inspection complete. Open Choose installation disk to confirm your target. Tell the assistant your preferences in chat.' : 'No eligible unmounted internal disks found. USB disks and disks with mounted partitions are excluded.';
      } catch (error) { archDisks = []; archInspection = ''; $('arch-status').textContent = error.message; }
    } else if (archDisks.length) {
      $('arch-status').textContent = message.type === 'exit' && message.code === 0 && message.reason === 'completed'
        ? 'Command finished. Ask AI for the next installation step.'
        : 'Review the latest command result. Ask AI to diagnose any error before continuing.';
    }
    const wasAutomatic = agent.running;
    const continueAutomatic = agent.result(activeCommand, message);
    progress(message.type === 'exit' && message.code === 0 ? `Step finished. ${continueAutomatic ? 'Continuing...' : ''}` : continueAutomatic ? 'This step encountered a problem. I’m checking the result and choosing the next diagnostic or repair step.' : 'The step stopped. Work is paused because it was interrupted or its outcome is unknown.');
    if (wasAutomatic && !continueAutomatic) $('auto-status').textContent = 'Automatic installation paused after an unsuccessful step. Ask the assistant to diagnose the result before resuming.';
    $('continue').hidden = continueAutomatic;
    clearTimeout(timer); active = null; update();
    if (pendingInstallGoal && activeCommand === INSPECT_ARCH) {
      const goal = pendingInstallGoal; pendingInstallGoal = null;
      if (message.type === 'exit' && message.code === 0 && ['completed','demo'].includes(message.reason) && archInspection) {
        void startTestInstall(goal, false).catch(error=>pauseAutomatic(error.message));
      }
    }
    if (continueAutomatic) scheduleAutomatic();
  }
}
function transmit(request) {
  const bytes = frame(request), current = generation;
  const write = async () => {
    if (current !== generation) throw new Error('Connection changed; request was not sent.');
    if (demo) { simulate(request); return; }
    if (!rx) throw new Error('Connect the device first.');
    for (let i = 0; i < bytes.length; i += 20) {
      if (current !== generation || !rx) throw new Error('Connection changed during request.');
      await rx.writeValueWithResponse(bytes.slice(i, i + 20));
    }
  };
  const result = writes.then(write);
  writes = result.catch(() => {});
  return result;
}
async function request(op, extra = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const expired = () => { pending.delete(id); reject(new Error('Device response timed out. Check pairing and the Linux bridge.')); };
    const item = {resolve,reject,timer:setTimeout(expired,60000)};
    pending.set(id, item);
    transmit({id,op,...extra}).then(() => {
      // Waiting behind other writes is not time spent waiting for the bridge's reply.
      if (pending.get(id) === item) { clearTimeout(item.timer); item.timer = setTimeout(expired,30000); }
    }).catch(error => { clearTimeout(item.timer); pending.delete(id); reject(error); });
  });
}
function onNotification(event) {
  try { const value = event.target.value; frames.feed(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)); }
  catch (error) { status(`Protocol error: ${error.message}`); device?.gatt.disconnect(); }
}
function nativeBase64(bytes) { return btoa(Array.from(bytes, value => String.fromCharCode(value)).join('')); }
if (nativeBLE) {
  globalThis.__linuxLinkNativeFrame = encoded => {
    try { frames.feed(Uint8Array.from(atob(encoded), value => value.charCodeAt(0))); }
    catch (error) { status(`Native Bluetooth protocol error: ${error.message}`); }
  };
  globalThis.__linuxLinkNativeConnected = () => nativeConnect?.resolve();
  globalThis.__linuxLinkNativeError = message => nativeConnect?.reject(new Error(message || 'Native Bluetooth connection failed.'));
  globalThis.__linuxLinkNativeDisconnected = () => disconnected();
}
async function connectNative() {
  connecting = true; update();
  try {
    await new Promise((resolve, reject) => { nativeConnect = {resolve, reject}; nativeBLE.connect(); });
    nativeConnect = null;
    device = {gatt:{disconnect:()=>nativeBLE.disconnect()}};
    rx = {writeValueWithResponse:async bytes => nativeBLE.write(nativeBase64(bytes))};
    status('Bluetooth connected. Checking the Linux bridge...'); update();
    await request('device');
    try { await ping(); } catch (error) { status(error.message); }
  } catch (error) {
    nativeConnect = null; nativeBLE.disconnect(); disconnected(); throw error;
  } finally { connecting = false; update(); }
}
async function connect() {
  if (nativeBLE) return connectNative();
  if (!window.isSecureContext || !navigator.bluetooth) throw new Error('Use Android Chrome over HTTPS, or localhost through adb reverse.');
  connecting = true; update();
  try {
    device = await navigator.bluetooth.requestDevice({filters:[{services:[UUID.service]}]});
    device.addEventListener('gattserverdisconnected', disconnected, {once:true});
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(UUID.service);
    rx = await service.getCharacteristic(UUID.rx);
    tx = await service.getCharacteristic(UUID.tx);
    tx.addEventListener('characteristicvaluechanged', onNotification);
    await tx.startNotifications();
    status('Complete Bluetooth pairing using the PIN from your firmware configuration.'); update();
    await request('device');
    status('Device connected. Boot the Arch image, then check the Linux connection.');
    try { await ping(); } catch (error) { status(error.message); }
  } catch (error) {
    device?.gatt.disconnect(); disconnected(); throw error;
  } finally { connecting = false; update(); }
}
async function ping() {
  if (checkingBridge) throw new Error('Already checking the Linux bridge.');
  const current = generation;
  checkingBridge = true; ready = false; update();
  status('Bluetooth connected. Checking the Linux bridge...');
  try {
    const result = await request('ping', {chat_capabilities:typeof DecompressionStream === 'function' ? ['deflate'] : []});
    if (current !== generation) return false;
    if (result.type !== 'ready' || result.protocol !== 1) throw new Error('Unsupported Linux bridge protocol.');
    bridgeEnvironment = result.environment || {};
    if (!modeChosen && bridgeEnvironment.default_mode) { setAssistantMode(bridgeEnvironment.default_mode); modeChosen = true; }
    ready = true;
    status(demo ? 'Demo mode — no commands run on a real computer.' : `Linux bridge ready${result.root ? ' · root session' : ''}.`);
    $('arch-status').textContent = 'Linux bridge ready. Tap Inspect computer to load disks.';
    return true;
  } catch (error) {
    if (current === generation) {
      const message = `Bluetooth is connected, but the Linux bridge did not respond: ${error.message} Start the bridge in Arch, then tap Inspect computer to retry.`;
      $('arch-status').textContent = message;
      throw new Error(message);
    }
    return false;
  } finally {
    if (current === generation) { checkingBridge = false; update(); }
  }
}
function simulate(message) {
  const {id,op} = message;
  if (op === 'ping') setTimeout(() => receive({id,type:'ready',protocol:1,root:true}), 80);
  else if (op === 'exec') {
    receive({id,type:'started'});
    demoTimer = setTimeout(() => {
      const data = message.command.startsWith('lsblk') ? JSON.stringify({blockdevices:[{name:'/dev/nvme0n1',size:'476.9G',model:'Example SSD',type:'disk',mountpoints:[null],tran:'nvme'},{name:'/dev/sda',size:'29.8G',model:'LinuxLink media',type:'disk',mountpoints:['/run/archiso/bootmnt'],tran:'usb'}]},null,2) + (message.command === INSPECT_ARCH ? '\n---SYSTEM---\nx86_64\nBOOT=UEFI\n' : '') : 'Simulated output only. Connect hardware to execute this command.\n';
      receive({id,type:'stdout',data}); receive({id,type:'exit',code:0,reason:'demo'});
    },700);
  } else if (op === 'cancel') {
    clearTimeout(demoTimer); receive({id,type:'cancel'});
    receive({id:message.target,type:'exit',code:-9,reason:'cancelled'});
  } else setTimeout(() => receive({id,type:op,message:'Demo key sent'}),50);
}
async function review() {
  if (!ready || active || aiBusy || checkingBridge) return;
  const command = $('command').value.trim(), timeout = Number($('timeout').value);
  if (!command || new TextEncoder().encode(command).length > 1200) throw new Error('Enter a command of at most 1200 UTF-8 bytes.');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('Timeout must be 1–3600 seconds.');
  pendingReview = {command,timeout};
  if (fastTest()) { await execute(); return; }
  $('review-command').textContent = command; $('ack').checked = false; $('review').showModal();
}
async function execute() {
  if (!ready || active || !pendingReview) return;
  const {command,timeout} = pendingReview; pendingReview = null;
  activeCommand = command; commandOutput = ''; $('proposal-run').hidden = true; $('continue').hidden = true;
  const id = crypto.randomUUID(); active = id; update(); append(`\n$ ${command}\n`);
  // A missing completion is unknown, never success. Keep cancellation available.
  timer = setTimeout(() => { pauseAutomatic('Completion not received. The command may still be running. Stop it or inspect the computer before retrying.'); }, (timeout + 30) * 1000);
  try { await transmit({id,op:'exec',command,timeout}); }
  catch (error) { clearTimeout(timer); pauseAutomatic(`Send failed; command outcome may be unknown: ${error.message}`); device?.gatt.disconnect(); }
}
function pauseAutomatic(message = 'Paused. Any running command will finish; use Stop command to cancel it.') {
  pendingInstallGoal = null;
  clearTimeout(autoTimer); agent.pause();
  $('auto-status').textContent = message; update();
}
function scheduleAutomatic() {
  const epoch = agent.epoch;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (!agent.running || agent.epoch !== epoch) return;
    if (aiBusy || active) { scheduleAutomatic(); return; }
    ask(troubleshooting() ? 'Continue the user’s troubleshooting request or task using saved state and actual results. Diagnose failures and verify the outcome before reporting completion.' : 'Continue the authorized installation using saved preferences and actual results. Inspect missing facts yourself. Report completion only after final verification.', false, true)
      .catch(error => pauseAutomatic(error.message));
  }, 150);
}
async function startAutomatic() {
  if (!ready || active || aiBusy || checkingBridge) return;
  agent.start(approvedDisk, assistantMode);
  update(); scheduleAutomatic();
}
async function startTestInstall(goal, inspect = true) {
  if (!ready) {
    if (!demo && !rx) throw new Error('Connect LinuxLink before starting installation.');
    if (!await ping()) return;
  }
  if (!approvedDisk && inspect) {
    pendingInstallGoal = goal;
    try { await inspectArch(); } catch (error) { pendingInstallGoal = null; throw error; }
    return;
  }
  approvedDisk = selectTestDisk(goal, archDisks, approvedDisk);
  agent.answer(`Test installation: erasure of ${approvedDisk} and automatic execution are authorized. Use defaults without asking for confirmation.`);
  $('arch-disk').value = approvedDisk;
  chat('assistant', `Starting automatic test installation on ${approvedDisk}. Use Pause or Stop to interrupt.`);
  await startAutomatic();
}
async function ask(suppliedGoal, retry = false, automaticTurn = false) {
  const goal = suppliedGoal || $('goal').value.trim();
  if (!goal) throw new Error('Type or dictate a message first.');
  if (active || aiBusy || checkingBridge) throw new Error('Wait for the current step to finish.');
  const current = generation;
  let autoEpoch = agent.epoch;
  if (!retry && !automaticTurn) { agent.answer(goal); remember('user', goal); $('goal').value = ''; }
  if (!automaticTurn && fastTest() && installRequest(goal)) {
    await startTestInstall(goal);
    return;
  }
  if (!automaticTurn && troubleshooting() && ready) {
    agent.start(null, 'troubleshoot'); automaticTurn = true; autoEpoch = agent.epoch;
  }
  retryGoal = goal;
  aiBusy = true; $('proposal-run').hidden = $('continue').hidden = $('retry').hidden = true;
  $('command').value = ''; pendingReview = null;
  if ($('review').open) $('review').close('cancel');
  update(); $('suggestion').textContent = 'Thinking... Temporary service errors are retried automatically.';
  try {
    let proposal;
    if (demo && automaticTurn) proposal = {explanation:'Demo automatic step: inspect the installed system. No actual installation takes place.',command:'test -f /mnt/etc/os-release',state:'Demo only.',status:'working'};
    else if (demo) proposal = archInspection
      ? {explanation:'Demo: which desktop would you like: GNOME, KDE Plasma, or a minimal command line installation?',command:''}
      : {explanation:'First, review this read-only inspection of the computer.',command:INSPECT_ARCH};
    else {
      const transcript = 'Initial inspection (may be stale):\n' + archInspection.slice(0,2000)
        + '\nCommand results:\n' + JSON.stringify(archHistory.slice(-5)) + '\nLatest output:\n' + log.slice(-3500);
      const response = await fetch('/api/plan', {method:'POST', headers:aiHeaders(),
        body:JSON.stringify({goal, transcript:transcript.slice(-12000), conversation:automaticTurn ? conversation : conversation.slice(0,-1),
          installation_context:{mode:assistantMode, environment:bridgeEnvironment, authorized_disk:troubleshooting() ? null : approvedDisk, inspected_disks:archDisks, ...agent.context()}}), signal:AbortSignal.timeout(65000)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Assistant request failed. Retry shortly.');
      proposal = result;
    }
    if (current !== generation) return;
    if (automaticTurn && (!agent.running || agent.epoch !== autoEpoch)) return;
    const autoExecute = agent.accept(proposal);
    remember('assistant', proposal.explanation);
    $('suggestion').textContent = '';
    $('command').value = proposal.command || '';
    $('timeout').value = proposal.command === INSPECT_ARCH ? '120' : '1800';
    $('proposal-run').hidden = !proposal.command;
    retryGoal = null;
    if (automaticTurn) {
      if (autoExecute) {
        if (!ready || (!troubleshooting() && !approvedDisk) || active) throw new Error('Connection or disk authorization changed.');
        const command = proposal.command.trim();
        if (!command || new TextEncoder().encode(command).length > 1200) throw new Error('Invalid automatic command.');
        pendingReview = {command, timeout:1800};
        await execute();
      } else {
        $('auto-status').textContent = troubleshooting() ? (proposal.status === 'complete' ? 'Task complete. Read the result in chat.' : proposal.status === 'conversation' ? 'Ready for your next message.' : 'Waiting for the action described in chat.') : proposal.status === 'complete'
          ? 'The assistant reports installation complete after verification. Read its final report below. Reboot manually when ready.'
          : 'Installation paused for the action described in chat. Once resolved, tap Install automatically to resume.';
      }
    }
  } catch (error) {
    if (current === generation) {
      if (automaticTurn) pauseAutomatic(`Automatic install paused: ${error.message}`);
      $('suggestion').textContent = `${error.message} Your conversation is still here. No command was run.`;
      $('retry').hidden = false;
    }
  } finally { aiBusy = false; update(); }
}
async function inspectArch() {
  if ((!demo && !rx) || active || aiBusy || checkingBridge || connecting) return;
  // Bluetooth can connect before Arch boots or before its bridge starts.
  // Retry the handshake here instead of permanently disabling inspection.
  if (!ready && !await ping()) return;
  approvedDisk = null; archDisks = []; archInspection = '';
  $('arch-erase').checked = false; $('arch-confirm').value = ''; $('arch-disk').value = '';
  $('command').value = INSPECT_ARCH; $('timeout').value = '120';
  $('arch-status').textContent = 'Inspecting the computer. Disk choices appear when it finishes.';
  pendingReview = {command:INSPECT_ARCH, timeout:120};
  update(); await execute();
}
async function nextArch() {
  if (!ready || active || aiBusy) return;
  const disk = $('arch-disk').value;
  if (!archDisks.some(item => item.name === disk)) {
    $('arch-status').textContent = 'Select an inspected disk first.';
    return;
  }
  if (!fastTest() && ($('arch-confirm').value !== disk || !$('arch-erase').checked)) {
    $('arch-status').textContent = 'Type the selected disk path exactly and confirm erasure.';
    return;
  }
  approvedDisk = disk;
  $('arch-status').textContent = `Erasure authorized for ${disk}. ${fastTest() ? 'Tap Run installation step to execute each suggestion.' : 'Each command still needs your review.'}`;
  $('disk-options').open = false;
  const note = `I authorize installing Arch on ${disk}, including erasing that disk. Keep my previous preferences.`;
  agent.answer(note); remember('user', note);
  chat('assistant', 'Disk selected. Tap Install automatically to use basic defaults and continue without step-by-step questions, or describe your preferences here.');
  update();
}
function setupVoice() {
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Recognition) {
    $('mic').disabled = true;
    $('voice-status').textContent = 'Voice is unavailable in this browser. Type a message or use your phone keyboard microphone.';
    return;
  }
  const recognition = new Recognition();
  recognition.lang = navigator.language || 'en-US'; recognition.interimResults = false;
  let listening = false, prefix = '';
  recognition.onend = () => { listening = false; $('mic').textContent = 'Microphone'; $('mic').setAttribute('aria-pressed','false'); };
  recognition.onerror = event => { $('voice-status').textContent = `Voice unavailable (${event.error}). Type instead or use your keyboard microphone.`; };
  recognition.onresult = event => {
    const words = Array.from(event.results).filter(result => result.isFinal).map(result => result[0].transcript).join(' ');
    $('goal').value = (prefix + ' ' + words).trim().slice(0,4000);
    $('voice-status').textContent = 'Check the transcription, then press Send.';
  };
  $('mic').onclick = () => {
    if (listening) { recognition.stop(); return; }
    prefix = $('goal').value;
    try {
      recognition.start(); listening = true; $('mic').textContent = 'Stop listening';
      $('mic').setAttribute('aria-pressed','true');
      $('voice-status').textContent = 'Listening. Your browser may send audio to its speech service. Nothing is sent to the installer until you press Send.';
    } catch { $('voice-status').textContent = 'Could not start the microphone. Type your message instead.'; }
  };
}
async function refreshAI() {
  try {
    const response = await fetch('/api/status');
    const info = await response.json();
    if (!response.ok) throw new Error(info.error);
    aiAuthRequired = info.auth_required !== false;
    $('token-field').hidden = !aiAuthRequired;
    $('ai-status').textContent = `${info.provider === 'gemini' ? 'Google Gemini' : 'OpenAI'} · ${info.model || 'No model selected'} · ${info.configured ? 'Configured — test the connection below.' : 'Run configure_ai.py on your Windows computer to add your API key.'}`;
  } catch (error) { $('ai-status').textContent = `Assistant configuration unavailable: ${error.message}`; }
}
async function testAI() {
  $('test-ai').disabled = true;
  $('ai-status').textContent = 'Testing the AI connection…';
  try {
    if (demo) { $('ai-status').textContent = 'Demo uses simulated suggestions. Exit demo to test your real AI connection.'; return; }
    const response = await fetch('/api/test', {method:'POST',headers:aiHeaders(),body:'{}',signal:AbortSignal.timeout(65000)});
    const info = await response.json();
    if (!response.ok) throw new Error(info.error || 'AI connection failed.');
    $('ai-status').textContent = info.message;
  } catch (error) { $('ai-status').textContent = error.message; }
  finally { $('test-ai').disabled = false; }
}
const safe = fn => async () => { try { await fn(); } catch (error) { status(error.message); } };
async function openTroubleshooting() {
  if ((!demo && !rx) || connecting || active || aiBusy || agent.running || checkingBridge || openingTerminal) throw new Error('Connect the device and pause any current task first.');
  if (!troubleshooting()) setAssistantMode('troubleshoot');
  modeChosen = true;
  openingTerminal = true; update();
  try {
  const result = await request('key', {key:'CTRL_ALT_F3'});
  if (result.type !== 'key') throw new Error('The device did not acknowledge the terminal shortcut.');
  if (!ready) {
    try { await ping(); }
    catch { status('Log in on the computer, then tap Start connection after login. Enter your sudo password on the computer if requested.'); return; }
  }
  status('Ctrl+Alt+F3 sent. Describe the problem in chat or use Microphone, then Send. The shortcut does not confirm which screen the PC is showing.');
  $('goal').focus?.();
  } finally { openingTerminal = false; update(); }
}
$('troubleshoot').onclick = safe(openTroubleshooting);
$('install-mode').onclick = safe(() => { setAssistantMode('install'); modeChosen = true; });
$('test-typing').onclick = safe(async () => {
  if (!troubleshooting() || (!demo && !rx) || active || aiBusy || agent.running || checkingBridge || openingTerminal) throw new Error('Connect the device and finish the current operation first.');
  const result = await request('key', {key:'TYPE_TEST'});
  if (result.type !== 'key') throw new Error('The device did not acknowledge the typing test.');
  status('Typing test sent. The computer console should display: LINUXLINK-TYPING-TEST');
});
$('mount-arch-card').onclick = safe(async () => {
  if (!troubleshooting() || (!demo && !rx) || active || aiBusy || agent.running || checkingBridge || openingTerminal) throw new Error('Connect the device and finish the current operation first.');
  const result = await request('key', {key:'MOUNT_ARCH_CARD'});
  if (result.type !== 'key') throw new Error('The device did not acknowledge the mount command.');
  status('Mount command typed. Enter your sudo password on the computer if asked, then wait for the prompt to return before choosing Install Arch connection.');
});
$('start-arch-bridge').onclick = safe(async () => {
  if (!troubleshooting() || (!demo && !rx) || active || aiBusy || agent.running || checkingBridge || openingTerminal) throw new Error('Connect the device and finish the current operation first.');
  openingTerminal = true; update();
  try {
    const result = await request('key', {key:'INSTALL_ARCH_BRIDGE'});
    if (result.type !== 'key') throw new Error('The device did not acknowledge bridge setup.');
    status('Install command typed. Enter your sudo password on the computer if asked. When it finishes, tap Check Linux connection.');
  } finally { openingTerminal = false; update(); }
});
$('assistant-mode').onchange = safe(async () => {
  const selected = $('assistant-mode').value;
  if (selected === 'troubleshoot') {
    try { await openTroubleshooting(); }
    catch (error) { $('assistant-mode').value = assistantMode; throw error; }
  } else { setAssistantMode(selected); modeChosen = true; }
});
$('connect').onclick = safe(connect);
$('demo').onclick = () => { demo = ready = true; log=''; status('Demo mode — no commands run on a real computer.'); append('[Demo session]\n'); update(); };
$('disconnect').onclick = () => { device?.gatt.disconnect(); disconnected(); };
$('ping').onclick = safe(ping); $('run').onclick = safe(review);
$('cancel').onclick = safe(() => { pauseAutomatic('Stopped. Cancelling the current command.'); return request('cancel',{target:active}); });
$('auto-start').onclick = safe(startAutomatic);
$('auto-pause').onclick = () => pauseAutomatic();
$('ask').onclick = safe(ask);
$('arch-inspect').onclick = safe(inspectArch);
$('arch-next').onclick = safe(nextArch);
$('arch-disk').onchange = () => { approvedDisk = null; $('arch-erase').checked = false; $('arch-confirm').value = ''; };
$('fast-test').onchange = () => {
  pendingReview = null;
  if ($('review').open) $('review').close('cancel');
  update();
};
$('test-ai').onclick = safe(testAI);
$('proposal-run').onclick = safe(review);
$('continue').onclick = safe(() => ask('Please review the latest command result and help me with the next step.'));
$('retry').onclick = safe(() => retryGoal && ask(retryGoal, true));
setupVoice();
chat('assistant', 'I can help you set up Arch Linux. Tell me what you want to use this computer for, and I will guide you through the options.');
$('clear').onclick = () => { log=''; $('output').textContent=''; };
$('review').addEventListener('close', safe(async () => { if ($('review').returnValue === 'run' && $('ack').checked) await execute(); else pendingReview = null; }));
document.querySelectorAll('[data-command]').forEach(button => button.onclick = () => { $('command').value = button.dataset.command; });
document.querySelectorAll('[data-key]').forEach(button => button.onclick = safe(async () => { await request('key',{key:button.dataset.key}); append(`[Key sent: ${button.dataset.key}]\n`); }));
update();
refreshAI();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
