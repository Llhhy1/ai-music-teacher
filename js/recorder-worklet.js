/**
 * recorder-worklet.js — 在音频线程里采集 PCM，攒够 1024 样本再回传，
 * 避免每 128 样本一次 postMessage 造成的消息风暴。
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(1024);
    this._n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush' && this._n > 0) this._flush();
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n === 1024) this._flush();
    }
    return true;
  }

  _flush() {
    this.port.postMessage(this._buf.slice(0, this._n));
    this._n = 0;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
