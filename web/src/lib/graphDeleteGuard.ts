// Duck-typed against DOM Element/EventTarget so this stays pure and testable without a browser: GraphView
// passes the real event.target, tests pass plain objects with just the fields a given case needs.
export interface DeleteGuardElement {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
  parentElement?: DeleteGuardElement | null;
}

const INTERACTIVE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY', 'DETAILS']);
// The app's own React Flow idiom for "interactive island inside a node" (CardNode's detail popup carries
// this), so it doubles as the delete guard's signal without hardcoding that component's class names.
const NODRAG_CLASS = 'nodrag';
const MAX_ANCESTOR_WALK = 50;

export function isGraphDeleteKey(key: string): boolean {
  return key === 'Delete' || key === 'Backspace';
}

function classListOf(el: DeleteGuardElement): string[] {
  const cls = el.getAttribute?.('class');
  return typeof cls === 'string' ? cls.split(/\s+/).filter(Boolean) : [];
}

// Walks target -> ancestors looking for a control the keypress should be understood as belonging to, rather
// than to the graph node it happens to sit inside (FAIL N2). Stops at the first interactive tag, contentEditable
// region, dialog landmark, or nodrag-marked island; an ordinary node wrapper/div/span matches none of these
// and the walk reaches its end, so deliberate delete on the selected node wrapper itself still proceeds.
function originatesInInteractiveControl(target: DeleteGuardElement | null | undefined): boolean {
  let node: DeleteGuardElement | null | undefined = target;
  for (let depth = 0; node && depth < MAX_ANCESTOR_WALK; depth += 1) {
    if (node.isContentEditable) return true;
    if (node.tagName && INTERACTIVE_TAGS.has(node.tagName)) return true;
    if (node.getAttribute?.('role') === 'dialog') return true;
    if (classListOf(node).includes(NODRAG_CLASS)) return true;
    node = node.parentElement;
  }
  return false;
}

export interface GraphDeleteKeyDecisionInput {
  key: string;
  target: DeleteGuardElement | null | undefined;
  isNodeDragActive: boolean;
}

// True when GraphView's Delete/Backspace handler must do nothing: not the delete shortcut at all, a node
// drag is still in flight (FAIL N1 — deleting mid-drag can leave onNodeDragStop, and the dragPause it clears,
// stuck), or the key originated in an interactive control/details panel rather than the graph canvas (FAIL N2).
export function shouldSkipGraphDeleteKey(input: GraphDeleteKeyDecisionInput): boolean {
  if (!isGraphDeleteKey(input.key)) return true;
  if (input.isNodeDragActive) return true;
  return originatesInInteractiveControl(input.target);
}
