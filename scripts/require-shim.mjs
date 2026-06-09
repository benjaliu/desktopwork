// Polyfill globalThis.require for ESM bundle compatibility
// dotenv (CJS module) uses `require('fs')` at module eval time.
// esbuild converts this to __require shim that throws in ESM
// because global require is undefined in ESM modules.
// This shim provides a working require via createRequire.
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
globalThis.require = req;
globalThis.__require = req;
export default req;