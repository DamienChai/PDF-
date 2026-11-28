// Types of the Emscripten glue module (pdfx.mjs). Copied to src/engine/dist by engine/build.sh.

/** Callbacks the WebAssembly module invokes synchronously. None of them may throw. */
export interface PdfxHost {
  /** Copy `length` bytes at `offset` of input `handle` to `dest` in the heap; return the count or < 0. */
  read(handle: number, offset: number, dest: number, length: number): number;
  /** Take a copy of `length` heap bytes at `data`; return 0, or < 0 on failure. */
  write(handle: number, data: number, length: number): number;
  progress(handle: number, percent: number): void;
}

export interface PdfxModuleOptions {
  pdfxHost: PdfxHost;
  /** Supplies the compiled module, so the glue never has to locate or fetch `pdfx.wasm` itself. */
  instantiateWasm(
    imports: WebAssembly.Imports,
    receiveInstance: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
  ): WebAssembly.Exports | Record<string, never>;
}

export interface PdfxModule {
  /** View of the heap. Re-read this property after any call into the module: growth replaces it. */
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _pdfx_inspect(request: number): number;
  _pdfx_process(request: number): number;
  _pdfx_free(response: number): void;
  _pdfx_version(): number;
  UTF8ToString(pointer: number): string;
  stringToUTF8(value: string, pointer: number, maxBytes: number): number;
  lengthBytesUTF8(value: string): number;
}

declare function createPdfx(options: PdfxModuleOptions): Promise<PdfxModule>;
export default createPdfx;
