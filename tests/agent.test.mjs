import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InstallAgent, DEFAULTS, installRequest, selectTestDisk} from '../app/agent.mjs';

test('troubleshooting needs no installation disk and can repeat diagnostics for verification', () => {
  const agent = new InstallAgent();
  agent.start(null, 'troubleshoot');
  const proposal = {command:'systemctl is-active NetworkManager',status:'working'};
  assert.equal(agent.accept(proposal),true);
  assert.equal(agent.result(proposal.command,{type:'exit',code:0,reason:'completed'}),true);
  assert.equal(agent.accept(proposal),true);
  agent.reset();
  assert.throws(()=>agent.start(null),/disk/);
});

test('test install intent selects only an unambiguous target', () => {
  for (const text of ['install linux', 'Please install Arch Linux with KDE', 'just install linux without confirmation']) assert.equal(installRequest(text), true);
  for (const text of ['How do I install linux?', 'do not install linux', 'install linux without erasing', 'install linux and preserve my files']) assert.equal(installRequest(text), false);
  const disks = [{name:'/dev/vda'}];
  assert.equal(selectTestDisk('install linux',disks), '/dev/vda');
  assert.throws(()=>selectTestDisk('install linux on /dev/sda',disks));
  assert.throws(()=>selectTestDisk('install linux',[...disks,{name:'/dev/vdb'}]));
});

test('defaults and user answers survive progress updates; commands require a running session', () => {
  const agent = new InstallAgent();
  agent.answer('Use KDE and UTC');
  agent.answer('Use KDE and UTC');
  assert.equal(agent.context().user_answers.length, 1);
  assert.equal(DEFAULTS.desktop, 'gnome');
  assert.throws(()=>agent.start(null), /disk/);
  agent.start('/dev/vda');
  assert.equal(agent.accept({command:'echo step',status:'working',state:'Desktop KDE, UTC; step proposed only'}), true);
  assert.equal(agent.result('echo step',{type:'exit',code:0,reason:'completed'}), true);
  assert.throws(()=>agent.accept({command:'echo step',status:'working'}), /repeated/);
  assert.equal(agent.running, false);
  assert.deepEqual(agent.context().user_answers, ['Use KDE and UTC']);
});

test('known failures continue to diagnosis, while unknown outcomes and cancellation stop', () => {
  const agent = new InstallAgent();
  agent.start('/dev/vda');
  assert.equal(agent.result('cmd', {type:'exit',code:1,reason:'completed'}), true);
  assert.equal(agent.running, true);
  assert.equal(agent.completed.has('cmd'), false);
  for (const result of [{type:'exit',code:0,reason:'output_limit'}, {type:'exit',code:1,reason:'cancelled'}, {type:'error',message:'lost'}]) {
    agent.start('/dev/vda');
    assert.equal(agent.result('cmd', result), false);
    assert.equal(agent.running, false);
  }
  for (const status of ['complete','needs_input']) {
    agent.start('/dev/vda');
    assert.equal(agent.accept({command:'',status}), false);
    assert.equal(agent.running, false);
  }
  agent.start('/dev/vda');
  const epoch = agent.epoch;
  agent.pause();
  assert.notEqual(agent.epoch, epoch);
  assert.equal(agent.accept({command:'echo late',status:'working'}), false);
});
