/*
 * Just enough of React's hooks to run src/lib/push.ts's usePushSync outside a page (see
 * push-client.test.ts): each render() calls the hook again, its refs and effects kept by call order,
 * and an effect runs, at once, when its deps differ from the last render's (or it has none).
 * render(hook, { mount: true }) is a component mounted afresh, whose effects all run.
 */
const refs = [];
const deps = [];
let next = 0;

export function useRef(initial) {
  const at = next++;
  if (!(at in refs)) refs[at] = { current: initial };
  return refs[at];
}

export function useEffect(effect, list) {
  const at = next++;
  const before = deps[at];
  deps[at] = list;
  if (list && before && list.length === before.length && list.every((v, i) => Object.is(v, before[i]))) return;
  effect();
}

export function render(hook, { mount = false } = {}) {
  if (mount) {
    refs.length = 0;
    deps.length = 0;
  }
  next = 0;
  hook();
}
