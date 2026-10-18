/*
 * Just enough of React's hooks to run src/lib/push.ts's usePushSync outside a page (see
 * push-client.test.ts): each render() calls the hook again, its refs kept by call order and its
 * effects run at once (each render's deps differ in those tests).
 */
const refs = [];
let next = 0;

export function useRef(initial) {
  const at = next++;
  if (!(at in refs)) refs[at] = { current: initial };
  return refs[at];
}

export function useEffect(effect) {
  effect();
}

export function render(hook) {
  next = 0;
  hook();
}
