import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createWindowDragDispatcher, setStableWindowBounds, windowControlPointer } from '../desktop/window-gestures.mjs';

const origin = 'http://127.0.0.1:3000';
function fixture() {
  const ipc = new EventEmitter();
  let cursor = { x: 300, y: 200 };
  const screen = { getCursorScreenPoint: () => cursor, getDisplayMatching: () => ({
    workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  }) };
  const dispatcher = createWindowDragDispatcher(ipc, screen);
  const windows = [1, 2].map(id => {
    const window = new EventEmitter();
    window.webContents = Object.assign(new EventEmitter(), { id, mainFrame: { url: origin + '/' }, getZoomFactor: () => 1 });
    window.bounds = { x: 50 * id, y: 70, width: 520, height: 600 };
    window.maximized = false; window.visible = true; window.destroyed = false; window.allowed = true;
    window.isDestroyed = () => window.destroyed;
    window.isMaximized = () => window.maximized;
    window.isFullScreen = () => false;
    window.isMinimized = () => false;
    window.isVisible = () => window.visible;
    window.getBounds = () => ({ ...window.bounds });
    window.setBounds = bounds => { window.bounds = { ...bounds }; };
    window.registration = dispatcher.register(window, origin, () => window.allowed);
    return window;
  });
  const send = (window, phase, overrides = {}) => ipc.emit('tuji:window-drag', { sender: window.webContents, senderFrame: window.webContents.mainFrame, ...overrides }, phase);
  return { ipc, screen, windows, send, cursor: point => { cursor = point; } };
}

test('one trusted dispatcher moves the sender only and preserves initial dimensions through repeated moves', () => {
  const f = fixture(), [main, panel] = f.windows;
  assert.equal(f.ipc.listenerCount('tuji:window-drag'), 1);
  const original = panel.getBounds(), other = main.getBounds();
  f.send(panel, 'start');
  for (const point of [{ x: -2000, y: 0 }, { x: 500, y: 400 }, { x: 310, y: 220 }]) {
    // An intervening OS/display dimension change cannot become the next move's size.
    panel.bounds.width += 10; panel.bounds.height += 5;
    f.cursor(point); f.send(panel, 'move');
    assert.deepEqual(panel.bounds, { x: original.x + point.x - 300, y: original.y + point.y - 200, width: original.width, height: original.height });
    assert.deepEqual(main.bounds, other);
  }
  f.send(panel, 'end');
  const ended = panel.getBounds(); f.cursor({ x: 0, y: 0 }); f.send(panel, 'move');
  assert.deepEqual(panel.bounds, ended);
  main.registration.dispose(); panel.registration.dispose();
  assert.equal(f.ipc.listenerCount('tuji:window-drag'), 0);
});

test('foreign frames, origins, hidden/maximized windows and docked panels cannot start dragging', () => {
  for (const kind of ['frame', 'origin', 'hidden', 'maximized', 'docked']) {
    const f = fixture(), window = f.windows[1], before = window.getBounds();
    let override = {};
    if (kind === 'frame') override = { senderFrame: { url: origin + '/' } };
    if (kind === 'origin') window.webContents.mainFrame.url = 'https://example.com/';
    if (kind === 'hidden') window.visible = false;
    if (kind === 'maximized') window.maximized = true;
    if (kind === 'docked') window.allowed = false;
    f.send(window, 'start', override); f.cursor({ x: 700, y: 500 }); f.send(window, 'move', override);
    assert.deepEqual(window.bounds, before, kind);
  }
});

test('resize is suppressed only during dragging, and lifecycle cancellation releases the gesture', () => {
  for (const cancel of ['cancel', 'blur', 'hide', 'maximize', 'minimize', 'closed', 'did-start-loading', 'render-process-gone']) {
    const f = fixture(), window = f.windows[0], before = window.getBounds();
    f.send(window, 'start');
    let prevented = false; window.emit('will-resize', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    if (cancel === 'cancel') f.send(window, 'cancel');
    else if (cancel.startsWith('did-') || cancel === 'render-process-gone') window.webContents.emit(cancel);
    else window.emit(cancel);
    prevented = false; window.emit('will-resize', { preventDefault() { prevented = true; } });
    assert.equal(prevented, false, cancel);
    f.cursor({ x: 800, y: 600 }); f.send(window, 'move');
    assert.deepEqual(window.bounds, before, cancel);
  }
});

test('only the 2 DIP top edge opens controls, while the revealed strip retains hover', () => {
  const f = fixture(), window = f.windows[0];
  window.bounds = { x: 100, y: 100, width: 1000, height: 700 };
  assert.deepEqual(windowControlPointer(window, f.screen, { x: 1090, y: 100 }), { edge: true, inside: true });
  assert.deepEqual(windowControlPointer(window, f.screen, { x: 1090, y: 101 }), { edge: true, inside: true });
  assert.deepEqual(windowControlPointer(window, f.screen, { x: 1090, y: 102 }), { edge: false, inside: true });
  assert.deepEqual(windowControlPointer(window, f.screen, { x: 1090, y: 131 }), { edge: false, inside: true });
  assert.deepEqual(windowControlPointer(window, f.screen, { x: 1090, y: 132 }), { edge: false, inside: false });
  assert.deepEqual(windowControlPointer(window, f.screen, { x: 970, y: 100 }), { edge: false, inside: false });
  window.maximized = true;
  window.bounds = { x: -1928, y: -8, width: 1936, height: 1056 };
  assert.deepEqual(windowControlPointer(window, f.screen, { x: -20, y: 0 }), { edge: true, inside: true });
  assert.deepEqual(windowControlPointer(window, f.screen, { x: -20, y: -8 }), { edge: false, inside: false });
});

test('fractional DPI readback offsets are corrected without changing the requested position', () => {
  let bounds, calls = 0;
  const window = {
    setBounds(request) { calls++; bounds = { ...request, width: request.width + 2, height: request.height + 1 }; },
    getBounds() { return { ...bounds }; },
  };
  const target = { x: 101, y: 202, width: 520, height: 720 };
  assert.deepEqual(setStableWindowBounds(window, target), target);
  assert.equal(calls, 2);
});

test('unrepresentable DPI coordinate phases use a neighbouring position while keeping dimensions exact', () => {
  let bounds, calls = 0;
  const window = {
    setBounds(request) {
      calls++;
      bounds = { ...request,
        width: request.x % 2 ? Math.floor(request.width / 2) * 2 + 1 : request.width,
        height: request.y % 2 ? Math.floor(request.height / 2) * 2 + 1 : request.height };
    },
    getBounds() { return { ...bounds }; },
  };
  assert.deepEqual(setStableWindowBounds(window, { x: 101, y: 203, width: 520, height: 720 }), { x: 100, y: 202, width: 520, height: 720 });
  assert.equal(calls, 4);
});

test('an unavoidable size approximation does not accumulate across separate gestures and respects a later resize', () => {
  const f = fixture(), window = f.windows[0];
  window.setBounds = request => { window.bounds = { ...request, width: Math.floor(request.width / 2) * 2 + 1 }; };
  for (let gesture = 0; gesture < 4; gesture++) {
    f.send(window, 'start'); f.cursor({ x: 400 + gesture * 20, y: 250 }); f.send(window, 'end');
    assert.equal(window.bounds.width, 521);
  }
  window.bounds.width = 600;
  f.send(window, 'start'); f.cursor({ x: 600, y: 300 }); f.send(window, 'end');
  assert.equal(window.bounds.width, 601);
});
