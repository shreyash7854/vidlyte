# VidLyte WASM Core

Source code for the Go WebAssembly (WASI Preview 1) engine.

For complete architectural specifications, exported functions, memory arena layouts, and build commands, refer to the root [WASM_README.md](file:///d:/@1/byse-norm/WASM_README.md).

### Quick Build
```powershell
powershell -Command "$env:GOOS='wasip1'; $env:GOARCH='wasm'; go build -ldflags='-s -w' -o ../../cloudflare-worker/src/vidlyte.wasm ."
```

