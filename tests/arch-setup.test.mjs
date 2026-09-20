import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inventory,archGoal,INSPECT_ARCH} from '../app/arch-setup.mjs';

const disk = {name:'/dev/nvme0n1',type:'disk',size:'100G',model:'Test SSD',mountpoints:[null],tran:'nvme'};
const preferences = {disk:disk.name,hostname:'archlinux',username:'alex',timezone:'America/New_York',desktop:'gnome'};
test('inspection excludes USB media, mounted descendants and non-disks', () => {
  const text = JSON.stringify({blockdevices:[disk,{...disk,name:'/dev/sda',tran:'usb'},
    {...disk,name:'/dev/nvme1n1',children:[{mountpoints:['/mnt/linuxlink-media']}]},
    {...disk,name:'/dev/loop0',type:'loop'}]}) + '\n---SYSTEM---\nx86_64';
  assert.deepEqual(inventory(text), [disk]);
  assert.throws(()=>inventory('not a result'));
  assert.ok(new TextEncoder().encode(INSPECT_ARCH).length < 1200);
});
test('installation goal requires inspected disk and exact erase confirmation', () => {
  assert.throws(()=>archGoal(preferences,[],disk.name,true),/Inspect/);
  assert.throws(()=>archGoal(preferences,[disk],'/dev/sda',true),/exactly/);
  assert.throws(()=>archGoal(preferences,[disk],disk.name,false),/exactly/);
  const goal = archGoal(preferences,[disk],disk.name,true);
  assert.match(goal,/authorize erasing ONLY \/dev\/nvme0n1/);
  assert.match(goal,/desktop=gnome/);
  assert.match(goal,/Do not reboot automatically/);
  assert.ok(goal.length + 1100 < 6000);
});
test('invalid preferences are rejected before asking the AI', () => {
  for (const change of [{hostname:'bad;command'},{username:'root'},{timezone:'foo;bar'},{desktop:'unexpected'}]) {
    assert.throws(()=>archGoal({...preferences,...change},[disk],disk.name,true));
  }
});
