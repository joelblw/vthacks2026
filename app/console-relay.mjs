export class ConsoleRelay {
  constructor(plan, send, report, acknowledge = async()=>{}) { this.plan = plan; this.send = send; this.report = report; this.acknowledge = acknowledge; this.pending = new Map(); this.generation = 0; }
  reset() { this.generation++; for (const item of this.pending.values()) clearTimeout(item.timer); this.pending.clear(); }
  async feed(message) {
    const current = this.generation;
    try {
      if (typeof message.id !== 'string' || message.id.length > 64) throw new Error('Invalid console request ID');
      if (message.seq === 0) {
        if (this.pending.size) throw new Error('Another console request is being received');
        const timer = setTimeout(()=>this.pending.delete(message.id), 120000);
        this.pending.set(message.id, {seq:0,data:'',timer,encoding:message.encoding});
      }
      const item = this.pending.get(message.id);
      if (!item || message.seq !== item.seq || typeof message.chunk !== 'string' || message.chunk.length > 1200) throw new Error('Invalid console request chunk');
      item.data += message.chunk; item.seq++;
      if (item.data.length > 90000) throw new Error('Console request too large');
      // Renew on progress, rather than expiring a healthy but slow BLE transfer.
      clearTimeout(item.timer);
      item.timer = setTimeout(()=>this.pending.delete(message.id), 120000);
      if (message.flow === 'ack') await this.acknowledge({id:message.id,seq:message.seq});
      if (current !== this.generation) return;
      if (!message.end) return;
      clearTimeout(item.timer); this.pending.delete(message.id);
      let decoded = Uint8Array.from(atob(item.data),c=>c.charCodeAt(0));
      if (item.encoding === 'deflate') {
        const reader = new Blob([decoded]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
        const chunks = []; let length = 0;
        try {
          while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            length += value.length;
            if (length > 65536) throw new Error('Decompressed console request too large');
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        decoded = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { decoded.set(chunk, offset); offset += chunk.length; }
      } else if (item.encoding && item.encoding !== 'base64') throw new Error('Unsupported console encoding');
      if (decoded.length > 65536) throw new Error('Console request too large');
      if (current !== this.generation) return;
      const body = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decoded));
      this.report('Computer chat: asking the AI...');
      let result;
      try { result = await this.plan(body); }
      catch (error) { result = {error:error.message}; }
      if (current !== this.generation) return;
      const bytes = new TextEncoder().encode(JSON.stringify(result));
      if (bytes.length > 65536) throw new Error('AI response too large for computer chat');
      const encoded = btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));
      for (let offset=0,seq=0; offset<encoded.length; offset+=768,seq++) {
        if (current !== this.generation) return;
        await this.send({id:message.id,seq,chunk:encoded.slice(offset,offset+768),end:offset+768>=encoded.length});
      }
      this.report(result.error ? `Computer chat: ${result.error}` : 'Computer chat: reply delivered.');
    } catch (error) {
      const item = this.pending.get(message.id);
      if (item) clearTimeout(item.timer);
      this.pending.delete(message.id);
      this.report(`Computer chat relay: ${error.message}`);
    }
  }
}
