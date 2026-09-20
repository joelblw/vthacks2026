export const UUID = Object.freeze({service:'7b910001-6b21-4c45-8c62-55b14b3af100',rx:'7b910002-6b21-4c45-8c62-55b14b3af100',tx:'7b910003-6b21-4c45-8c62-55b14b3af100'});
export function frame(request) {
  const bytes = new TextEncoder().encode(JSON.stringify(request) + '\n');
  if (bytes.length > 2049) throw new Error('Request exceeds the device frame limit.');
  return bytes;
}
export class Frames {
  constructor(onMessage) { this.onMessage = onMessage; this.bytes = []; }
  feed(chunk) {
    for (const byte of chunk) {
      if (byte === 10) {
        const line = new TextDecoder('utf-8', {fatal:true}).decode(new Uint8Array(this.bytes));
        this.bytes = [];
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid device response.');
        this.onMessage(message);
      } else {
        this.bytes.push(byte);
        if (this.bytes.length > 2048) { this.bytes = []; throw new Error('Device response exceeds frame limit.'); }
      }
    }
  }
}
