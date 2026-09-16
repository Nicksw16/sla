import { clamp } from '../core/MathUtils.js';

/**
 * Touch controls (spec §101: the same game on a phone, not a cut-down one).
 *
 * A phone has no keyboard, so without this the game loads and cannot be flown. The
 * layout mirrors the keyboard: a self-centring stick under the left thumb for bank and
 * pitch, a throttle under the right, and the buttons that matter in the air within
 * reach of both. Everything writes into the same axis set the keyboard and the gamepad
 * write into, so the flight model never learns where the input came from.
 *
 * It only builds itself on a device that reports touch, and only shows while flying.
 */
const STICK_RADIUS = 62;

export class TouchControls {
  constructor({ input, bus, settings }) {
    this.input = input;
    this.bus = bus;
    this.settings = settings;
    this.available = TouchControls.isTouchDevice();
    this.visible = false;
    if (!this.available) return;

    this.root = document.createElement('div');
    this.root.id = 'touch-controls';
    this.root.className = 'touch hidden';
    this.root.innerHTML = `
      <div class="touch-stick" id="touch-stick"><i></i></div>
      <div class="touch-throttle" id="touch-throttle">
        <div class="tt-fill"></div><span>THR</span>
      </div>
      <div class="touch-buttons">
        <button class="touch-btn wide" data-touch="turbo">TURBO</button>
        <button class="touch-btn" data-touch="brake">BRAKE</button>
        <button class="touch-btn" data-touch="levelOut">LEVEL</button>
      </div>
      <div class="touch-top">
        <button class="touch-btn small" data-touch="camera">CAM</button>
        <button class="touch-btn small" data-touch="restart">RESET</button>
        <button class="touch-btn small" data-touch="pause">❚❚</button>
      </div>`;
    document.body.appendChild(this.root);
    // The stylesheet keys the whole touch layout off this, so the HUD moves out from
    // under the thumbs and the portrait notice knows it is on a phone.
    document.body.classList.add('touch-device');

    this.stick = this.root.querySelector('#touch-stick');
    this.knob = this.stick.querySelector('i');
    this.throttleEl = this.root.querySelector('#touch-throttle');
    this.throttleFill = this.throttleEl.querySelector('.tt-fill');

    this.stickId = null;
    this.throttleId = null;
    this.stickOrigin = { x: 0, y: 0 };
    // Throttle is a position, not a rate: on a touchscreen you set it and let go.
    this.throttle = 0.75;
    this._wire();
  }

  static isTouchDevice() {
    return typeof window !== 'undefined'
      && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
  }

  _wire() {
    const stickDown = (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      const r = this.stick.getBoundingClientRect();
      this.stickOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.stick.setPointerCapture(e.pointerId);
      this._moveStick(e);
      e.preventDefault();
    };
    this.stick.addEventListener('pointerdown', stickDown);
    this.stick.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) { this._moveStick(e); e.preventDefault(); }
    });
    const stickUp = (e) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.input.touch.roll = 0;
      this.input.touch.pitch = 0;
      this.knob.style.transform = 'translate(0px, 0px)';
    };
    this.stick.addEventListener('pointerup', stickUp);
    this.stick.addEventListener('pointercancel', stickUp);

    const throttleMove = (e) => {
      const r = this.throttleEl.getBoundingClientRect();
      // Bottom of the strip is idle, top is full.
      this.throttle = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      this.throttleFill.style.height = `${(this.throttle * 100).toFixed(0)}%`;
      this.input.touch.throttleTarget = this.throttle;
    };
    this.throttleEl.addEventListener('pointerdown', (e) => {
      this.throttleId = e.pointerId;
      this.throttleEl.setPointerCapture(e.pointerId);
      throttleMove(e);
      e.preventDefault();
    });
    this.throttleEl.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.throttleId) { throttleMove(e); e.preventDefault(); }
    });
    const throttleUp = (e) => { if (e.pointerId === this.throttleId) this.throttleId = null; };
    this.throttleEl.addEventListener('pointerup', throttleUp);
    this.throttleEl.addEventListener('pointercancel', throttleUp);

    for (const btn of this.root.querySelectorAll('[data-touch]')) {
      const action = btn.dataset.touch;
      const press = (e) => {
        e.preventDefault();
        btn.classList.add('on');
        if (action === 'camera' || action === 'restart' || action === 'pause') {
          this.input.touch.taps.push(action);
        } else {
          this.input.touch.buttons[action] = true;
        }
      };
      const release = () => {
        btn.classList.remove('on');
        if (action in this.input.touch.buttons) this.input.touch.buttons[action] = false;
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
    }
  }

  _moveStick(e) {
    const dx = e.clientX - this.stickOrigin.x;
    const dy = e.clientY - this.stickOrigin.y;
    const len = Math.hypot(dx, dy);
    const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
    const kx = dx * k;
    const ky = dy * k;
    this.knob.style.transform = `translate(${kx.toFixed(1)}px, ${ky.toFixed(1)}px)`;
    this.input.touch.roll = clamp(kx / STICK_RADIUS, -1, 1);
    // Screen down is nose down, the way a stick works.
    // Dragged back to climb, like the column it stands in for and like every other
    // input in the game.
    this.input.touch.pitch = clamp(ky / STICK_RADIUS, -1, 1);
  }

  /** Shown while flying, hidden behind every menu. */
  setVisible(v) {
    if (!this.available || this.visible === v) return;
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
    if (!v) {
      this.input.touch.roll = 0;
      this.input.touch.pitch = 0;
      for (const k of Object.keys(this.input.touch.buttons)) this.input.touch.buttons[k] = false;
      this.knob.style.transform = 'translate(0px, 0px)';
    }
  }

  /** Reflects a throttle the game changed on its own, e.g. at mission start. */
  syncThrottle(value) {
    if (!this.available) return;
    this.throttle = clamp(value, 0, 1);
    this.input.touch.throttleTarget = this.throttle;
    this.throttleFill.style.height = `${(this.throttle * 100).toFixed(0)}%`;
  }
}
