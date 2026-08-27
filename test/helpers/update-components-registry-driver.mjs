import { updateComponentsRegistry } from '../../cli/lib/components-registry.js';

const [component, version, delayText = '0', mode = 'transaction'] = process.argv.slice(2);
const delayMs = Number(delayText);

function delay() {
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}

if (mode === 'save-components') {
  const { loadComponents, saveComponents } = await import('../../cli/lib/components.js');
  const components = loadComponents();
  delay();
  components[component] = {
    ...components[component],
    version,
  };
  saveComponents(components);
} else {
  updateComponentsRegistry(components => {
    delay();
    components[component] = {
      ...components[component],
      version,
    };
    return components;
  });
}
