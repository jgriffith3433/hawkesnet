// Demo-only Network lab: latency / jitter / loss on this client's own SDK sends and receives.
// No service change. Other rooms and peers without this shim are unaffected.
// Wired from public/demo.html; playtests use window.hawkesPlaytest.lab / window.hawkesNetLab.

export const LAB_LATENCY = [0, 100, 250];
export const LAB_JITTER = [0, 30];
export const LAB_LOSS = [0, 5];

function pick(v, allowed, fallback = allowed[0]) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return allowed.includes(n) ? n : fallback;
}

function copyPayload(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return data;
}

/**
 * Creates the lab controller. `attach(room)` wraps that room's transport only (call for the page's net, not bots).
 */
export function createLab() {
  const state = { latency: 0, jitter: 0, loss: 0 };
  const listeners = new Set();
  const wireOut = [];
  const wireIn = [];
  let open = false;
  let ui = null;

  const active = () => state.latency > 0 || state.jitter > 0 || state.loss > 0;
  const snapshot = () => ({
    latency: state.latency,
    jitter: state.jitter,
    loss: state.loss,
    active: active(),
    open,
  });

  const notify = () => {
    const s = snapshot();
    for (const fn of listeners) {
      try { fn(s); } catch { /* ignore */ }
    }
    syncUi();
  };

  const delayMs = () => state.latency + (state.jitter > 0 ? Math.random() * state.jitter : 0);
  const shouldDrop = () => state.loss > 0 && Math.random() * 100 < state.loss;

  const noteOut = () => {
    const t = performance.now();
    wireOut.push(t);
    if (wireOut.length > 200) wireOut.shift();
    return t;
  };
  const noteIn = () => {
    const t = performance.now();
    wireIn.push(t);
    if (wireIn.length > 200) wireIn.shift();
    return t;
  };

  function schedule(fn) {
    if (!active()) return void fn();
    if (shouldDrop()) return;
    const d = delayMs();
    if (d <= 0) return void fn();
    setTimeout(fn, d);
  }

  /**
   * Wrap this client's Room so outbound `_sendRoom` and inbound socket/host frames take the lab path.
   * Control / signalling (`_control`) is left alone so offers and ICE stay sharp.
   */
  function attach(room) {
    if (!room || room._hawkesLab) return room;
    room._hawkesLab = true;

    const origSend = room._sendRoom.bind(room);
    room._sendRoom = (msgs) => {
      if (!active()) return origSend(msgs);
      if (shouldDrop()) return;
      // Stamp when the frame enters the shim (before delay) so one-way lab latency is measurable.
      noteOut();
      const d = delayMs();
      const batch = Array.isArray(msgs) ? msgs.slice() : msgs;
      if (d <= 0) return origSend(batch);
      setTimeout(() => origSend(batch), d);
    };

    const origSock = room._fromSocket.bind(room);
    room._fromSocket = (data) => {
      if (!active()) return origSock(data);
      if (shouldDrop()) return;
      const payload = copyPayload(data);
      const d = delayMs();
      const go = () => { noteIn(); origSock(payload); };
      if (d <= 0) go();
      else setTimeout(go, d);
    };

    const origHost = room._fromHost.bind(room);
    room._fromHost = (u8, carrier) => {
      if (!active()) return origHost(u8, carrier);
      if (shouldDrop()) return;
      const copy = u8 instanceof Uint8Array ? new Uint8Array(u8) : u8;
      const d = delayMs();
      const go = () => { noteIn(); origHost(copy, carrier); };
      if (d <= 0) go();
      else setTimeout(go, d);
    };

    // express bypasses _sendRoom; keep lab behaviour consistent for raw frames.
    const origExpress = room.express.bind(room);
    room.express = (bytes, opt = {}) => {
      if (!active()) return origExpress(bytes, opt);
      if (shouldDrop()) return false;
      noteOut();
      const d = delayMs();
      if (d <= 0) return origExpress(bytes, opt);
      const payload = bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes;
      setTimeout(() => origExpress(payload, opt), d);
      return true;
    };

    return room;
  }

  function set(opts = {}) {
    if (opts && typeof opts === 'object') {
      if ('latency' in opts) state.latency = pick(opts.latency, LAB_LATENCY);
      if ('jitter' in opts) state.jitter = pick(opts.jitter, LAB_JITTER);
      if ('loss' in opts) state.loss = pick(opts.loss, LAB_LOSS);
    }
    notify();
    return snapshot();
  }

  function setOpen(next) {
    open = Boolean(next);
    notify();
    return snapshot();
  }

  function phoneLayout() {
    return typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
  }

  function syncUi() {
    if (!ui) return;
    const s = snapshot();
    const phone = phoneLayout();
    ui.chip.hidden = !s.active;
    ui.chip.setAttribute('aria-hidden', s.active ? 'false' : 'true');
    ui.fab.setAttribute('aria-expanded', s.open ? 'true' : 'false');
    ui.fab.classList.toggle('lab-active', s.active);
    // Desktop: folded card always in the page (body shown when open). Phone: bottom sheet only while open.
    if (phone) {
      ui.panel.hidden = !s.open;
      ui.backdrop.hidden = !s.open;
    } else {
      ui.panel.hidden = false;
      ui.backdrop.hidden = true;
    }
    ui.panel.classList.toggle('open', s.open);
    ui.backdrop.classList.toggle('open', phone && s.open);
    ui.panel.setAttribute('role', phone ? 'dialog' : 'region');
    for (const key of ['latency', 'jitter', 'loss']) {
      for (const btn of ui.panel.querySelectorAll(`[data-lab="${key}"]`)) {
        const on = Number(btn.dataset.value) === s[key];
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('on', on);
      }
    }
    ui.summary.textContent = s.active
      ? `${s.latency} ms · jitter ${s.jitter} · loss ${s.loss}%`
      : 'Off — this client only';
  }

  function mount(root = document) {
    if (ui) return api;
    const chip = root.getElementById('lab-chip');
    const fab = root.getElementById('lab-toggle');
    const panel = root.getElementById('lab-panel');
    const backdrop = root.getElementById('lab-backdrop');
    const summary = root.getElementById('lab-summary');
    const closeBtn = root.getElementById('lab-close');
    if (!chip || !fab || !panel || !backdrop || !summary) {
      throw new Error('demo lab markup missing (#lab-chip, #lab-toggle, #lab-panel, #lab-backdrop, #lab-summary)');
    }
    ui = { chip, fab, panel, backdrop, summary };

    const toggle = () => setOpen(!open);
    fab.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    closeBtn?.addEventListener('click', (e) => { e.preventDefault(); setOpen(false); });
    backdrop.addEventListener('click', () => setOpen(false));
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest?.('[data-lab]');
      if (!btn) return;
      e.preventDefault();
      set({ [btn.dataset.lab]: Number(btn.dataset.value) });
    });

    // Desktop folded card: the summary row also toggles.
    summary.addEventListener('click', (e) => {
      if (e.target.closest?.('[data-lab], #lab-close')) return;
      // On phone the fab opens the sheet; summary is inside the sheet.
      if (matchMedia('(max-width: 640px)').matches && open) return;
      toggle();
    });

    syncUi();
    return api;
  }

  /** True when the phone bottom sheet is closed and no lab overlay covers the arena canvas. */
  function clearOfCanvas(canvas) {
    if (!ui) return true;
    if (phoneLayout()) {
      if (open) return false;
      if (!ui.panel.hidden || ui.panel.classList.contains('open')) return false;
      if (!ui.backdrop.hidden || ui.backdrop.classList.contains('open')) return false;
    }
    if (!canvas || !phoneLayout()) return true;
    const cr = canvas.getBoundingClientRect();
    for (const el of [ui.panel, ui.backdrop]) {
      if (el.hidden) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const overlap = !(r.right <= cr.left || r.left >= cr.right || r.bottom <= cr.top || r.top >= cr.bottom);
      if (overlap) return false;
    }
    return true;
  }

  const api = {
    get: snapshot,
    set,
    lab: set,
    attach,
    mount,
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    clearStamps: () => { wireOut.length = 0; wireIn.length = 0; },
    wireOut: () => wireOut.slice(),
    wireIn: () => wireIn.slice(),
    clearOfCanvas,
    schedule,
  };
  return api;
}
