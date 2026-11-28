// Emscripten JS library: the three functions pdfx.cc imports.
//
// They forward to the `pdfxHost` object passed to the module factory, which is implemented in
// src/engine/core.ts. The host functions must not throw; they report failure by return value.
addToLibrary({
  pdfx_js_read: (handle, offset, dest, length) =>
    Module['pdfxHost']['read'](handle, offset, dest, length),
  pdfx_js_write: (handle, data, length) => Module['pdfxHost']['write'](handle, data, length),
  pdfx_js_progress: (handle, percent) => {
    Module['pdfxHost']['progress'](handle, percent);
  },
});
