import { uiAudio, type UiAudio } from './uiAudio';

type Editor = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
interface Composition {
  active: boolean; before: string; start: number | null; end: number | null;
  lastData?: string;
  committed?: { data: string; value: string; expected: string; at: number };
}
const buttonSelector = 'button, a[href], summary, select, input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [data-ui-sound="button"]';
const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
const insertTypes = new Set(['insertText', 'insertFromPaste', 'insertFromDrop', 'insertReplacementText', 'insertFromComposition']);

function editor(target: EventTarget | null): Editor | null {
  if (!(target instanceof HTMLElement) || target.closest('[inert], [data-ui-sound="off"]')) return null;
  if (target instanceof HTMLInputElement) return textTypes.has(target.type) && !target.disabled && !target.readOnly ? target : null;
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly ? target : null;
  return target.isContentEditable ? target : null;
}
const valueOf = (target: Editor) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target.textContent ?? '';
function button(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  let match = target.closest(buttonSelector);
  if (!match) {
    const label = target.closest('label');
    if (label?.control?.matches('input[type="checkbox"], input[type="radio"]')) match = label.control;
  }
  return match && !match.matches(':disabled') && !match.closest('[aria-disabled="true"], [aria-hidden="true"], [inert], [data-ui-sound="off"]') ? match : null;
}

/** Native capture listeners also cover portals and avoid React renders for hover/typing. */
export function installUiSoundEvents(audio: UiAudio = uiAudio): () => void {
  const compositions = new WeakMap<Editor, Composition>();
  let hovered: Element | null = null, dragging = false, disposed = false;
  const over = (event: PointerEvent) => {
    if (!event.isTrusted || event.pointerType === 'touch') return;
    const next = button(event.target);
    if (next === hovered) return;
    hovered = next;
    if (next && !event.buttons && !dragging) audio.play('button');
  };
  const out = (event: PointerEvent) => { if (button(event.relatedTarget) !== hovered) hovered = null; };
  const pointer = (event: PointerEvent) => { if (event.isTrusted) audio.unlock(); };
  const key = (event: KeyboardEvent) => {
    if (!event.isTrusted) return;
    audio.unlock();
    const target = editor(event.target), state = target && compositions.get(target);
    if (state && !event.isComposing && !state.active) state.committed = undefined;
  };
  const start = (event: CompositionEvent) => {
    const target = editor(event.target); if (!event.isTrusted || !target) return;
    compositions.set(target, { active: true, before: valueOf(target),
      start: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.selectionStart : null,
      end: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.selectionEnd : null });
  };
  const end = (event: CompositionEvent) => {
    const target = editor(event.target); if (!target) return;
    const previous = compositions.get(target);
    // Chromium integrations can finish a trusted native composition with an untrusted end.
    // Accept that only when it closes the same text actually received from native input.
    if (!event.isTrusted && (!previous?.active || previous.lastData !== event.data)) return;
    const state = previous ?? { active: true, before: '', start: null, end: null };
    state.active = false;
    const value = valueOf(target), data = event.data;
    const expected = state.start !== null && state.end !== null ? state.before.slice(0, state.start) + data + state.before.slice(state.end) : value;
    state.committed = { data, value, expected, at: performance.now() }; compositions.set(target, state);
    // Some engines send their final input before compositionend, others send it after.
    // Only the composition transaction owns this sound; cancellation has empty data.
    if (data) queueMicrotask(() => { if (!disposed) audio.play('input'); });
  };
  const input = (event: Event) => {
    const target = editor(event.target);
    if (!event.isTrusted || !target || !(event instanceof InputEvent)) return;
    const state = compositions.get(target);
    if (state?.active && event.isComposing) state.lastData = event.data ?? '';
    if (event.isComposing || state?.active || event.inputType === 'insertCompositionText') return;
    if (!insertTypes.has(event.inputType) || event.data === '') return;
    const committed = state?.committed;
    if (committed) {
      state.committed = undefined;
      if (performance.now() - committed.at < 150 && event.data === committed.data &&
        [committed.value, committed.expected].includes(valueOf(target))) return;
    }
    audio.play('input');
  };
  const paste = (event: ClipboardEvent) => {
    const target = editor(event.target), state = target && compositions.get(target);
    if (state && !state.active) state.committed = undefined;
  };
  const dragStart = () => { dragging = true; hovered = null; };
  const dragEnd = () => { dragging = false; hovered = null; };
  const blur = () => { dragEnd(); audio.pause(); };
  const visibility = () => { if (document.visibilityState !== 'visible') blur(); };
  document.addEventListener('pointerover', over, true); document.addEventListener('pointerout', out, true);
  document.addEventListener('pointerdown', pointer, true); document.addEventListener('keydown', key, true);
  document.addEventListener('compositionstart', start, true); document.addEventListener('compositionend', end, true);
  document.addEventListener('input', input, true); document.addEventListener('paste', paste, true);
  document.addEventListener('dragstart', dragStart, true); document.addEventListener('dragend', dragEnd, true);
  document.addEventListener('drop', dragEnd, true); document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', blur);
  return () => {
    disposed = true;
    document.removeEventListener('pointerover', over, true); document.removeEventListener('pointerout', out, true);
    document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', key, true);
    document.removeEventListener('compositionstart', start, true); document.removeEventListener('compositionend', end, true);
    document.removeEventListener('input', input, true); document.removeEventListener('paste', paste, true);
    document.removeEventListener('dragstart', dragStart, true); document.removeEventListener('dragend', dragEnd, true);
    document.removeEventListener('drop', dragEnd, true); document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('blur', blur); audio.dispose();
  };
}

/** Only for an actual user insertion handled with setRangeText/preventDefault. */
export function soundForHandledInsertion(target: HTMLElement, text: string, trusted: boolean) {
  if (trusted && text && editor(target)) uiAudio.play('input');
}
