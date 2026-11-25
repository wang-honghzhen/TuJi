const plain = {
  Digit1:'2d', Digit2:'layered', Digit3:'sphere', KeyV:'next', Digit4:'neighbors', Digit5:'selected',
  Space:'toggle', KeyG:'inspect', KeyI:'internal', KeyX:'cross', KeyB:'outside', KeyF:'locate',
} as const;

export function canvasDisplayCommand(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat || e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.shiftKey) {
    if (e.code === 'Space') return 'allGroups';
    if (e.code === 'KeyR') return 'allRelations';
    if (e.code === 'KeyV') return 'previous';
    return;
  }
  return plain[e.code as keyof typeof plain];
}
