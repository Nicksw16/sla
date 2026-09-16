import { clamp, clamp01, damp, deadzone, expoCurve } from './MathUtils.js';

/**
 * Default PC bindings follow spec §100. Pitch is on the arrow keys / mouse /
 * stick because the spec's list assigns W-S to throttle and A-D to turning.
 *
 * Pitch is the way round an aeroplane works, which is the opposite of the way a camera
 * works. You pull a control column back to raise the nose and push it forward to drop
 * it, so on a keyboard Down raises the nose and Up lowers it, on a mouse you draw the
 * hand back to climb, and on a stick you pull. Every flight simulator defaults this way.
 * This game did not: it used the camera convention, where up means up, which is right
 * for a third-person camera and wrong for anything with wings.
 *
 * Anyone who prefers the other way has INVERT PITCH in the settings, which now inverts
 * away from the aircraft convention rather than towards it.
 */
export const DEFAULT_BINDINGS = {
  throttleUp: ['KeyW'],
  throttleDown: ['KeyS'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  // Pull back to climb: the key that raises the nose is Down.
  pitchUp: ['ArrowDown'],
  pitchDown: ['ArrowUp'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  turbo: ['ShiftLeft', 'ShiftRight'],
  brake: ['Space'],
  levelOut: ['KeyZ'],
  restart: ['KeyR'],
  pause: ['Escape'],
  camera: ['KeyC'],
  look: ['KeyV'],
  minimap: ['KeyM'],
  hud: ['KeyH'],
  photo: ['KeyP'],
  fps: ['F1'],
};

const ANALOG_ACTIONS = ['pitch', 'roll', 'yaw'];

/**
 * Unified keyboard / mouse / gamepad input.
 *
 * Produces a stable analog axis set regardless of device, applies sensitivity,
 * dead zones and an expo curve, and exposes edge-triggered "pressed" queries for
 * UI. Smoothing of control *surfaces* deliberately lives in FlightModel, not
 * here: input reports what the player asked for, the aircraft decides how fast
 * it can comply (spec §11).
 */
export class Input {
  constructor(settings, bus) {
    this.settings = settings;
    this.bus = bus;
    this.bindings = { ...DEFAULT_BINDINGS, ...(settings.get('bindings') || {}) };

    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();
    this.enabled = true;

    this.axes = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };
    this.buttons = { turbo: false, brake: false, look: false, levelOut: false };
    this.mouse = { dx: 0, dy: 0, x: 0, y: 0, down: false, wheel: 0, locked: false };
    // Written by TouchControls. throttleTarget is an absolute lever position rather
    // than a rate, because a thumb sets a throttle and lets go of it.
    this.touch = {
      roll: 0, pitch: 0, yaw: 0, throttleTarget: null,
      buttons: { turbo: false, brake: false, levelOut: false },
      taps: [],
    };
    this.gamepadIndex = null;
    this.gamepadConnected = false;
    this._vibrateUntil = 0;

    this._smoothed = { pitch: 0, roll: 0, yaw: 0 };
    this._mouseAim = { pitch: 0, roll: 0 };
    this._bind();
  }

  _bind() {
    const onKeyDown = (e) => {
      // Never swallow browser-level combos.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!this.keys.has(e.code)) this.pressedThisFrame.add(e.code);
      this.keys.add(e.code);
      // Stop arrows/space from scrolling the page while flying.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F1'].includes(e.code)) {
        e.preventDefault();
      }
      this.bus?.emit('input:key', e.code);
    };
    const onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.releasedThisFrame.add(e.code);
    };
    const onBlur = () => {
      // Dropping held keys on focus loss prevents a stuck full-throttle bug.
      this.keys.clear();
      this.buttons.turbo = false;
      this.buttons.brake = false;
    };

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    window.addEventListener('mousemove', (e) => {
      if (this.mouse.locked) {
        this.mouse.dx += e.movementX;
        this.mouse.dy += e.movementY;
      }
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
    });
    window.addEventListener('mousedown', () => { this.mouse.down = true; });
    window.addEventListener('mouseup', () => { this.mouse.down = false; });
    window.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.mouse.locked = document.pointerLockElement != null;
    });

    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.gamepadConnected = true;
      this.bus?.emit('input:gamepad', { connected: true, id: e.gamepad.id });
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
      this.gamepadConnected = false;
      this.bus?.emit('input:gamepad', { connected: false });
    });
  }

  setBindings(bindings) {
    this.bindings = { ...DEFAULT_BINDINGS, ...bindings };
    this.settings.set('bindings', bindings);
  }

  isDown(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** True only on the frame the action went down. */
  wasPressed(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  requestMouseLock(element) {
    if (!this.settings.get('mouseSteering')) return;
    // A sandboxed embed (an artifact iframe without allow-pointer-lock) throws a
    // SecurityError synchronously here rather than just declining quietly, which
    // would otherwise take the mission-start call site down with it.
    try { element?.requestPointerLock?.(); } catch { /* not available here */ }
  }

  releaseMouseLock() {
    if (document.pointerLockElement) {
      try { document.exitPointerLock?.(); } catch { /* nothing to release */ }
    }
  }

  _pollGamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    let pad = this.gamepadIndex != null ? pads[this.gamepadIndex] : null;
    if (!pad) {
      for (const p of pads) if (p && p.connected) { pad = p; this.gamepadIndex = p.index; break; }
    }
    this.gamepadConnected = !!pad;
    return pad;
  }

  /** Short rumble; silently ignored on pads without an actuator (spec §102). */
  vibrate(strength = 0.4, duration = 120) {
    if (!this.settings.get('vibration')) return;
    const pad = this.gamepadIndex != null ? navigator.getGamepads?.()[this.gamepadIndex] : null;
    const act = pad?.vibrationActuator;
    if (!act?.playEffect) return;
    const now = performance.now();
    if (now < this._vibrateUntil) return;
    this._vibrateUntil = now + duration * 0.7;
    act.playEffect('dual-rumble', {
      duration,
      strongMagnitude: clamp01(strength),
      weakMagnitude: clamp01(strength * 0.6),
    }).catch(() => {});
  }

  /** Call once per frame, before systems read the axes. */
  update(dt) {
    const sens = this.settings.get('sensitivity');
    const invert = this.settings.get('invertPitch') ? -1 : 1;

    let pitch = 0, roll = 0, yaw = 0, throttleDelta = 0;
    let turbo = false, brake = false, look = false, levelOut = false;

    if (this.enabled) {
      if (this.isDown('pitchUp')) pitch += 1;
      if (this.isDown('pitchDown')) pitch -= 1;
      if (this.isDown('rollLeft')) roll -= 1;
      if (this.isDown('rollRight')) roll += 1;
      if (this.isDown('yawLeft')) yaw -= 1;
      if (this.isDown('yawRight')) yaw += 1;
      if (this.isDown('throttleUp')) throttleDelta += 1;
      if (this.isDown('throttleDown')) throttleDelta -= 1;
      turbo = this.isDown('turbo');
      brake = this.isDown('brake');
      look = this.isDown('look');
      levelOut = this.isDown('levelOut');

      // Mouse steering: the cursor offset acts as a self-centring virtual stick.
      if (this.settings.get('mouseSteering')) {
        if (this.mouse.locked) {
          const k = 0.0022 * sens;
          this._mouseAim.pitch = clamp(this._mouseAim.pitch + this.mouse.dy * k, -1, 1);
          this._mouseAim.roll = clamp(this._mouseAim.roll + this.mouse.dx * k, -1, 1);
          // Re-centres slowly so the aircraft returns to neutral when the hand stops.
          this._mouseAim.pitch = damp(this._mouseAim.pitch, 0, 1.6, dt);
          this._mouseAim.roll = damp(this._mouseAim.roll, 0, 1.6, dt);
        } else {
          this._mouseAim.pitch = clamp(this.mouse.y * 1.1, -1, 1);
          this._mouseAim.roll = clamp(this.mouse.x * 1.1, -1, 1);
        }
        if (Math.abs(this._mouseAim.pitch) > Math.abs(pitch)) pitch = this._mouseAim.pitch;
        if (Math.abs(this._mouseAim.roll) > Math.abs(roll)) roll = this._mouseAim.roll;
      }

      // Touch: the stick wins over anything else, because a thumb on screen is a
      // deliberate input and nothing else is competing for it.
      const t = this.touch;
      if (Math.abs(t.roll) > Math.abs(roll)) roll = t.roll;
      if (Math.abs(t.pitch) > Math.abs(pitch)) pitch = t.pitch;
      if (t.buttons.turbo) turbo = true;
      if (t.buttons.brake) brake = true;
      if (t.buttons.levelOut) levelOut = true;
      for (const tap of t.taps) {
        const binding = this.bindings[tap];
        if (binding) this.pressedThisFrame.add(binding[0]);
      }
      t.taps.length = 0;

      const pad = this._pollGamepad();
      if (pad) {
        const ax = (i) => deadzone(pad.axes[i] ?? 0);
        const gpRoll = ax(0);
        const gpPitch = ax(1);
        const gpYaw = ax(2);
        if (Math.abs(gpRoll) > Math.abs(roll)) roll = gpRoll;
        if (Math.abs(gpPitch) > Math.abs(pitch)) pitch = gpPitch;
        if (Math.abs(gpYaw) > Math.abs(yaw)) yaw = gpYaw;
        const rt = pad.buttons[7]?.value ?? 0;
        const lt = pad.buttons[6]?.value ?? 0;
        if (rt > 0.08) throttleDelta = Math.max(throttleDelta, rt);
        if (lt > 0.08) throttleDelta = Math.min(throttleDelta, -lt);
        turbo = turbo || !!pad.buttons[5]?.pressed || !!pad.buttons[0]?.pressed;
        brake = brake || !!pad.buttons[4]?.pressed || !!pad.buttons[2]?.pressed;
        look = look || !!pad.buttons[10]?.pressed;
        if (pad.buttons[9]?.pressed) this.pressedThisFrame.add(this.bindings.pause[0]);
        if (pad.buttons[3]?.pressed) this.pressedThisFrame.add(this.bindings.camera[0]);
      }
    }

    // Expo + sensitivity, then a light smoothing pass so keyboard taps are not
    // instant step inputs. The aircraft applies its own rate limits on top.
    const shape = (v) => clamp(expoCurve(clamp(v, -1, 1), 1.45) * sens, -1.25, 1.25);
    const target = { pitch: shape(pitch) * invert, roll: shape(roll), yaw: shape(yaw) * 0.9 };
    for (const a of ANALOG_ACTIONS) {
      this._smoothed[a] = damp(this._smoothed[a], target[a], 14, dt);
      this.axes[a] = this._smoothed[a];
    }

    this.axes.throttle = clamp(throttleDelta, -1, 1);
    // A touch throttle is a position. The flight model integrates a rate, so this is
    // the error between where the lever is and where the thumb left it.
    this.throttleTarget = this.touch.throttleTarget;
    this.buttons.turbo = turbo;
    this.buttons.brake = brake;
    this.buttons.look = look;
    this.buttons.levelOut = levelOut;

    this.mouse.dx = 0;
    this.mouse.dy = 0;
  }

  /** Clears edge state; call at the very end of the frame. */
  endFrame() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mouse.wheel = 0;
  }
}
