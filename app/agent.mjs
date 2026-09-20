export const DEFAULTS = Object.freeze({desktop:'gnome', hostname:'archlinux', username:'linuxuser',
  timezone:'UTC', locale:'en_US.UTF-8', filesystem:'ext4', encryption:false, dual_boot:false});

export function installRequest(text) {
  if (/\?|\b(don't|do not|never|avoid|keep|preserve|dual.boot)\b|without\s+(erasing|formatting|wiping)/i.test(text)) return false;
  return /^(?:(?:please|just)\s+)*(?:install|set up)\s+(?:arch(?:\s+linux)?|linux)(?:[.!]|$|\s+(?:on|with|using|for|without)\b)/i.test(text.trim());
}
export function selectTestDisk(goal, disks, previous = null) {
  const mentioned = goal.match(/\/dev\/[A-Za-z0-9/_-]+/g) || [];
  if (mentioned.length) {
    if (new Set(mentioned).size !== 1 || !disks.some(d=>d.name === mentioned[0])) throw new Error('The requested target is not a single eligible internal disk. Inspect disks and choose the target.');
    return mentioned[0];
  }
  if (previous) return previous;
  if (disks.length !== 1) throw new Error('Specify the installation disk: there is not exactly one eligible unmounted internal disk.');
  return disks[0].name;
}

// Kept separately from the rolling chat, so assistant chatter cannot evict answers.
export class InstallAgent {
  constructor() { this.reset(); }
  reset() { this.running = false; this.epoch = (this.epoch || 0) + 1; this.steps = 0; this.state = ''; this.answers = []; this.completed = new Set(); }
  answer(text) {
    if (!this.answers.includes(text)) this.answers.push(text);
    // Do not silently lose preferences: require a new session if unusually large.
    if (JSON.stringify(this.answers).length > 10000) { this.answers.pop(); throw new Error('Installation notes are full. Finish this session before adding more preferences.'); }
  }
  start(disk, mode = 'install') { if (mode !== 'troubleshoot' && !disk) throw new Error('Choose and authorize the installation disk first.'); this.mode = mode; this.running = true; this.steps = 0; this.epoch++; }
  pause() { this.running = false; this.epoch++; }
  context() { return {automatic:this.running, defaults:DEFAULTS, saved_state:this.state, user_answers:this.answers}; }
  accept(proposal) {
    if (typeof proposal.state === 'string') this.state = proposal.state;
    if (!this.running) return false;
    if (!proposal.command || proposal.status !== 'working') { this.pause(); return false; }
    if (this.mode !== 'troubleshoot' && this.completed.has(proposal.command.trim())) { this.pause(); throw new Error('Automatic install paused: the AI repeated an already successful command. Ask it to inspect progress and continue.'); }
    if (++this.steps > 60) { this.pause(); throw new Error('Automatic install paused after 60 steps. Check progress before resuming.'); }
    return true;
  }
  result(command, message) {
    if (message.type === 'exit' && message.code === 0 && ['completed','demo'].includes(message.reason)) {
      this.completed.add(command.trim()); return this.running;
    }
    // A reported process exit is safe to diagnose; a lost connection or cancel is not.
    if (message.type === 'exit' && message.reason === 'completed' && Number.isInteger(message.code)) return this.running;
    this.pause(); return false;
  }
}
