/**
 * Test-only resolver: lets `node --test` load the app's own extensionless
 * relative imports (`./spec`), which Node's ESM resolver does not do on its own.
 *
 * The alternative — writing `./spec.ts` in application source — would push a
 * test-runner constraint into files the bundler owns. This keeps the constraint
 * where it belongs.
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw err;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
  // The bundler imports data files (`./nodeFloors.json`) without an import attribute;
  // Node's ESM loader insists on one. Serve them as a module with a default export.
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.json')) {
      const source = `export default ${readFileSync(fileURLToPath(url), 'utf8')};`;
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
