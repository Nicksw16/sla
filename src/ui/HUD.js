import * as THREE from 'three';
import { clamp, clamp01, formatClock, formatDistance, formatNumber } from '../core/MathUtils.js';

/**
 * In-flight HUD (spec §71-74).
 *
 * Two rules govern what is here. Everything shown must be something the player acts
 * on — speed, altitude, hull, turbo, where the next gate is, how long is left (§71 says
 * show only what is needed; §156 warns against an overloaded HUD). And every important
 * event gets a visible acknowledgement, because an action with no feedback reads as a
 * bug (§74, §144).
 *
 * The nav marker is projected from the world each frame and clamped to the screen edge
 * when the gate is out of view, so "where do I go" is never a question (§31-33).
 */
export class HUD {
  constructor({ bus, settings, camera }) {
    this.bus = bus;
    this.settings = settings;
    this.camera = camera;
    this.visible = false;

    const $ = (id) => document.getElementById(id);
    this.el = {
      root: $('hud'),
      missionName: $('hud-mission-name'),
      objective: $('hud-objective'),
      timer: $('hud-timer'),
      timerValue: $('hud-timer-value'),
      progress: $('hud-progress'),
      cpCur: $('hud-cp-cur'),
      cpTotal: $('hud-cp-total'),
      score: $('hud-score'),
      combo: $('hud-combo'),
      comboValue: $('hud-combo-value'),
      rival: $('hud-rival'),
      rivalGap: $('hud-rival-gap'),
      speed: $('hud-speed'),
      alt: $('hud-alt'),
      agl: $('hud-agl'),
      aglValue: $('hud-agl-value'),
      barThrottle: $('bar-throttle'),
      barTurbo: $('bar-turbo'),
      barHp: $('bar-hp'),
      navMarker: $('nav-marker'),
      navDist: document.querySelector('#nav-marker .nav-dist'),
      navEdge: $('nav-edge'),
      horizon: $('horizon'),
      toastStack: $('toast-stack'),
      popupStack: $('popup-stack'),
      warnStall: $('warn-stall'),
      warnPullup: $('warn-pullup'),
      vignette: $('vignette'),
      minimapWrap: $('minimap'),
      minimapLabel: $('minimap-label'),
    };

    this._projected = new THREE.Vector3();
    this._displayScore = 0;
    this._lastCountdown = 4;
    this._toasts = [];

    this._unsubs = [
      bus.on('score:popup', (e) => this.popup(e)),
      bus.on('score:combo', (e) => this.setCombo(e.combo, e.broken)),
      bus.on('mission:start', (e) => this.onMissionStart(e)),
      bus.on('mission:objective', (e) => this.onObjectiveChange(e)),
      bus.on('mission:warning', (e) => this.setMissionWarning(e.text)),
      bus.on('mission:go', () => this.toast('GO', 'good', 1.1, true)),
      bus.on('mission:reset', () => this.toast('RESET TO LAST CHECKPOINT', 'warn', 2.2)),
      bus.on('checkpoint:passed', (e) => this.onCheckpoint(e)),
      bus.on('damage:hit', (e) => this.onDamage(e)),
      bus.on('flight:landed', (e) => this.toast(e.quality > 0.8 ? 'TEXTBOOK LANDING' : 'DOWN SAFE', 'good', 2)),
      bus.on('flight:takeoff', () => this.toast('AIRBORNE', 'good', 1.6)),
      bus.on('weather:change', (e) => this.toast(`WEATHER: ${e.name}`, 'warn', 2.4)),
      bus.on('turbo:empty', () => this.toast('TURBO DEPLETED', 'warn', 1.4)),
      bus.on('save:recovered', () => this.toast('PROGRESS RECOVERED FROM BACKUP', 'warn', 4)),
      bus.on('save:corrupt', () => this.toast('SAVE UNREADABLE — STARTING FRESH', 'bad', 5)),
      settings.onChange((k) => { if (k === 'hudScale' || k === '*') this._applyScale(); }),
    ];
    this._applyScale();
  }

  _applyScale() {
    const scale = this.settings.get('hudScale');
    this.el.root.classList.toggle('scale-small', scale === 'small');
    this.el.root.classList.toggle('scale-large', scale === 'large');
  }

  show() {
    this.visible = true;
    this.el.root.classList.remove('hidden');
    this.el.root.setAttribute('aria-hidden', 'false');
  }

  hide() {
    this.visible = false;
    this.el.root.classList.add('hidden');
    this.el.root.setAttribute('aria-hidden', 'true');
  }

  onMissionStart(e) {
    this.el.missionName.textContent = e.name ?? 'FREE FLIGHT';
    this.el.objective.textContent = e.objective ?? '';
    this._displayScore = 0;
    this.el.score.textContent = '0';
    this.setCombo(1);
    this.el.rival.classList.toggle('hidden', !e.rival);
    this._lastCountdown = 4;
    if (e.tip) this.toast(e.tip, 'warn', 6);
  }

  onObjectiveChange(e) {
    if (e.objective) this.el.objective.textContent = e.objective;
    if (e.text) this.toast(e.text, 'warn', 3, true);
  }

  onCheckpoint(e) {
    if (e.isFinal) return;
    if (e.remaining <= 3) this.toast(`${e.remaining} TO GO`, 'good', 1.2);
  }

  onDamage(e) {
    if (e.damage <= 0) return;
    // No banner. The hit already announces itself three other ways - the screen
    // flashes red in proportion to it, the hull bar drops, and the camera is thrown
    // - and a line of text on top of that was the least informative of the four
    // while being the one that covered the view of what you had just flown into.
    // A red flash proportional to the hit, because damage you do not notice is
    // damage you cannot learn from (§145).
    this.el.vignette.style.opacity = String(clamp01(e.damage / 50) * 0.9);
    setTimeout(() => { this.el.vignette.style.opacity = '0'; }, 160);
  }

  setCombo(combo, broken = false) {
    const show = combo > 1.02;
    this.el.combo.classList.toggle('hidden', !show);
    this.el.combo.classList.toggle('hot', combo >= 3);
    this.el.comboValue.textContent = combo.toFixed(2).replace(/0$/, '');
    if (broken) this.popup({ label: 'COMBO LOST', value: 0, kind: 'penalty' });
  }

  setMissionWarning(text) {
    this._missionWarning = text;
  }

  toast(text, kind = '', duration = 2, big = false) {
    const node = document.createElement('div');
    node.className = `toast ${kind}${big ? ' big' : ''}`;
    node.textContent = text;
    this.el.toastStack.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity 0.3s';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 320);
    }, duration * 1000);
    // Never let toasts stack up into a wall of text.
    while (this.el.toastStack.children.length > 4) this.el.toastStack.firstChild.remove();
  }

  popup({ label, value, kind = 'score' }) {
    const node = document.createElement('div');
    node.className = `popup ${kind}`;
    const sign = value > 0 ? '+' : '';
    node.textContent = value ? `${label}  ${sign}${formatNumber(value)}` : label;
    this.el.popupStack.appendChild(node);
    setTimeout(() => node.remove(), 900);
    while (this.el.popupStack.children.length > 5) this.el.popupStack.firstChild.remove();
  }

  /** Per-frame refresh. */
  update(dt, { status, telemetry, turbo, damage, score, spec, world }) {
    if (!this.visible) return;

    // --- gauges
    this.el.speed.textContent = String(Math.round(telemetry.speedKmh));
    this.el.alt.textContent = String(Math.round(telemetry.altitude));
    const overspeed = telemetry.speed > spec.maxSpeed * 0.97;
    this.el.speed.parentElement.classList.toggle('overspeed', overspeed);

    // Above-ground height only appears when it matters, i.e. when you are low.
    const agl = telemetry.aboveGround;
    const showAgl = agl < 260;
    this.el.agl.classList.toggle('hidden', !showAgl);
    if (showAgl) this.el.aglValue.textContent = String(Math.round(agl));

    // --- bars
    this.el.barThrottle.style.width = `${telemetry.throttle * 100}%`;
    const turboFrac = turbo?.fraction ?? 0;
    this.el.barTurbo.style.width = `${turboFrac * 100}%`;
    this.el.barTurbo.classList.toggle('empty', !turbo?.available);
    const hp = damage?.fraction ?? 1;
    this.el.barHp.style.width = `${hp * 100}%`;
    this.el.barHp.classList.toggle('hurt', hp < 0.6 && hp >= 0.3);
    this.el.barHp.classList.toggle('critical', hp < 0.3);

    // --- score, counted up rather than snapped, so gains register
    if (score) {
      const target = score.score;
      this._displayScore += (target - this._displayScore) * Math.min(1, dt * 9);
      if (Math.abs(target - this._displayScore) < 1) this._displayScore = target;
      this.el.score.textContent = formatNumber(this._displayScore);
    }

    // --- mission block
    this.el.missionName.textContent = status.name || 'FREE FLIGHT';
    const hasTimer = status.hasTimeLimit && status.state !== 'idle';
    this.el.timer.classList.toggle('hidden', !hasTimer);
    if (hasTimer) {
      this.el.timerValue.textContent = formatClock(status.timeRemaining);
      this.el.timer.classList.toggle('warn', status.timeRemaining < 25 && status.timeRemaining >= 10);
      this.el.timer.classList.toggle('critical', status.timeRemaining < 10);
    }
    const showProgress = status.checkpointTotal > 0;
    this.el.progress.classList.toggle('hidden', !showProgress);
    if (showProgress) {
      this.el.cpCur.textContent = String(status.checkpointIndex);
      this.el.cpTotal.textContent = String(status.checkpointTotal);
    }

    // --- countdown beeps and banner
    if (status.countdown > 0) {
      const whole = Math.ceil(status.countdown);
      if (whole < this._lastCountdown) {
        this._lastCountdown = whole;
        this.toast(String(whole), '', 0.8, true);
        this.bus.emit('ui:countdownBeep', { whole });
      }
    }

    // --- rival gap
    if (status.rivalGap) {
      const g = status.rivalGap;
      const ahead = g.lead > 0 || (g.lead === 0 && g.metres > 0);
      this.el.rival.classList.remove('hidden');
      this.el.rival.classList.toggle('ahead', ahead);
      this.el.rival.classList.toggle('behind', !ahead);
      this.el.rivalGap.textContent = g.finished
        ? 'FINISHED'
        : `${ahead ? '+' : '-'}${formatDistance(Math.abs(g.metres))}`;
    } else {
      this.el.rival.classList.add('hidden');
    }

    // --- warnings. Order matters: terrain beats stall beats a rule violation.
    const pullUp = !telemetry.grounded && telemetry.aboveGround < 70 && telemetry.verticalSpeed < -8;
    this.el.warnPullup.classList.toggle('hidden', !pullUp);
    this.el.warnStall.classList.toggle('hidden', !(telemetry.stall > 0.4 && !telemetry.grounded));
    if (this._missionWarning && !pullUp) {
      this.el.warnStall.classList.add('hidden');
      this.el.warnStall.textContent = this._missionWarning;
      this.el.warnStall.classList.remove('hidden');
    } else if (telemetry.stall > 0.4) {
      this.el.warnStall.textContent = 'STALL — LOWER THE NOSE';
    }

    this._updateNav(status.nav, telemetry);
    this.el.horizon.classList.toggle('hidden', this.settings.get('cameraMode') === 'cockpit');
  }

  /** Projects the next gate to the screen, or pins an arrow to the edge (§73). */
  _updateNav(nav, telemetry) {
    if (!nav) {
      this.el.navMarker.classList.add('hidden');
      this.el.navEdge.classList.add('hidden');
      return;
    }
    this._projected.copy(nav.position).project(this.camera);
    const w = window.innerWidth, h = window.innerHeight;
    const onScreen = this._projected.z < 1 &&
      this._projected.x > -0.96 && this._projected.x < 0.96 &&
      this._projected.y > -0.94 && this._projected.y < 0.94;

    if (onScreen) {
      const x = (this._projected.x * 0.5 + 0.5) * w;
      const y = (-this._projected.y * 0.5 + 0.5) * h;
      this.el.navMarker.classList.remove('hidden');
      this.el.navEdge.classList.add('hidden');
      this.el.navMarker.style.left = `${x}px`;
      this.el.navMarker.style.top = `${y}px`;
      // Shrink the reticle as the gate fills the view, so it stops covering the target.
      const scale = clamp(320 / Math.max(nav.distance, 60), 0.35, 1.25);
      this.el.navMarker.style.transform = `scale(${scale})`;
      const climb = nav.altitudeDelta > 45 ? ' ▲' : nav.altitudeDelta < -45 ? ' ▼' : '';
      this.el.navDist.textContent = `${formatDistance(nav.distance)}${climb}`;
    } else {
      this.el.navMarker.classList.add('hidden');
      this.el.navEdge.classList.remove('hidden');
      // Direction from screen centre toward the target, clamped to a border inset.
      let dx = this._projected.x;
      let dy = this._projected.y;
      if (this._projected.z >= 1) { dx = -dx; dy = -dy; } // behind the camera
      const len = Math.hypot(dx, dy) || 1;
      const inset = 52;
      const nx = dx / len, ny = dy / len;
      const maxX = (w / 2) - inset, maxY = (h / 2) - inset;
      const t = Math.min(Math.abs(maxX / (nx || 1e-6)), Math.abs(maxY / (ny || 1e-6)));
      const x = w / 2 + nx * t;
      const y = h / 2 - ny * t;
      this.el.navEdge.style.left = `${x}px`;
      this.el.navEdge.style.top = `${y}px`;
      this.el.navEdge.style.transform = `rotate(${Math.atan2(nx, ny) + Math.PI}rad)`;
    }
  }

  dispose() {
    for (const u of this._unsubs) u?.();
  }
}
