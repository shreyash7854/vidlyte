/**
 * Zero-dependency WASI (WebAssembly System Interface) Preview 1 Shim
 * Designed specifically for Cloudflare Workers & Modern Edge V8 Environments.
 */

export class WASI {
  constructor(options = {}) {
    this.args = options.args || ["vidlyte.wasm"];
    this.env = options.env || {};
    this.instance = null;
  }

  getImportObject() {
    return {
      wasi_snapshot_preview1: {
        args_sizes_get: (argcPtr, argvBufSizePtr) => {
          const view = new DataView(this.instance.exports.memory.buffer);
          view.setUint32(argcPtr, this.args.length, true);
          let bufSize = 0;
          for (const arg of this.args) {
            bufSize += new TextEncoder().encode(arg).length + 1;
          }
          view.setUint32(argvBufSizePtr, bufSize, true);
          return 0; // ESUCCESS
        },
        args_get: (argvPtr, argvBufPtr) => {
          const view = new DataView(this.instance.exports.memory.buffer);
          const mem = new Uint8Array(this.instance.exports.memory.buffer);
          let offset = argvBufPtr;
          for (let i = 0; i < this.args.length; i++) {
            view.setUint32(argvPtr + i * 4, offset, true);
            const bytes = new TextEncoder().encode(this.args[i]);
            mem.set(bytes, offset);
            mem[offset + bytes.length] = 0;
            offset += bytes.length + 1;
          }
          return 0;
        },
        environ_sizes_get: (countPtr, sizePtr) => {
          const view = new DataView(this.instance.exports.memory.buffer);
          const entries = Object.entries(this.env);
          view.setUint32(countPtr, entries.length, true);
          let size = 0;
          for (const [k, v] of entries) {
            size += new TextEncoder().encode(`${k}=${v}`).length + 1;
          }
          view.setUint32(sizePtr, size, true);
          return 0;
        },
        environ_get: (environPtr, environBufPtr) => {
          const view = new DataView(this.instance.exports.memory.buffer);
          const mem = new Uint8Array(this.instance.exports.memory.buffer);
          const entries = Object.entries(this.env);
          let offset = environBufPtr;
          for (let i = 0; i < entries.length; i++) {
            view.setUint32(environPtr + i * 4, offset, true);
            const str = `${entries[i][0]}=${entries[i][1]}`;
            const bytes = new TextEncoder().encode(str);
            mem.set(bytes, offset);
            mem[offset + bytes.length] = 0;
            offset += bytes.length + 1;
          }
          return 0;
        },
        clock_time_get: (id, precision, timePtr) => {
          const nowMs = Date.now();
          const view = new DataView(this.instance.exports.memory.buffer);
          const nanos = BigInt(nowMs) * 1000000n;
          view.setBigUint64(timePtr, nanos, true);
          return 0;
        },
        fd_close: () => 0,
        fd_fdstat_get: (fd, statPtr) => {
          const view = new DataView(this.instance.exports.memory.buffer);
          view.setUint8(statPtr, fd <= 2 ? 2 : 0);
          view.setUint16(statPtr + 2, 0, true);
          view.setBigUint64(statPtr + 8, 0n, true);
          view.setBigUint64(statPtr + 16, 0n, true);
          return 0;
        },
        fd_fdstat_set_flags: () => 0,
        fd_prestat_get: () => 8, // EBADF
        fd_prestat_dir_name: () => 8,
        fd_read: () => 0,
        fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
          const view = new DataView(this.instance.exports.memory.buffer);
          let total = 0;
          for (let i = 0; i < iovsLen; i++) {
            const len = view.getUint32(iovsPtr + i * 8 + 4, true);
            total += len;
          }
          view.setUint32(nwrittenPtr, total, true);
          return 0;
        },
        path_filestat_get: () => 44, // ENOENT
        path_open: () => 44,
        poll_oneoff: () => 0,
        proc_exit: () => 0,
        random_get: (bufPtr, bufLen) => {
          const mem = new Uint8Array(this.instance.exports.memory.buffer);
          if (typeof crypto !== "undefined" && crypto.getRandomValues) {
            crypto.getRandomValues(mem.subarray(bufPtr, bufPtr + bufLen));
          } else {
            for (let i = 0; i < bufLen; i++) {
              mem[bufPtr + i] = Math.floor(Math.random() * 256);
            }
          }
          return 0;
        },
        sched_yield: () => 0,
      },
    };
  }

  initialize(instance) {
    this.instance = instance;
    if (instance.exports._initialize) {
      instance.exports._initialize();
    }
  }
}
