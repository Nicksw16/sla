import { REGIONS, REGION_ORDER, TILE, COAST_Z, LANDMARKS, RUNWAY } from '../data/regions.js';

/**
 * Minimap (spec §72).
 *
 * Rotates with the aircraft so "up" is always where the nose points, which is the only
 * orientation that helps in the air. Draws the district blocks, the coast, the route
 * ahead and the landmarks — enough to navigate by, not a second view of the game.
 */
const RANGE = 2600; // metres from edge to edge

export class Minimap {
  constructor({ canvas, settings }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.settings = settings;
    this.size = canvas.width;
    this.enabled = settings.get('minimap');
    settings.onChange((k, v) => {
      if (k === 'minimap') this.setEnabled(v);
    });
    this.setEnabled(this.enabled);
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.canvas.style.display = this.enabled ? 'block' : 'none';
    const label = document.getElementById('minimap-label');
    if (label) label.style.display = this.enabled ? 'block' : 'none';
  }

  /** World metres to minimap pixels, before the canvas rotation is applied. */
  _px(worldDelta) {
    return (worldDelta / RANGE) * this.size;
  }

  draw({ position, heading, route, checkpointIndex, rivalPosition, region }) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const s = this.size;
    const px = position.x, pz = position.z;

    ctx.clearRect(0, 0, s, s);
    ctx.save();
    // Circular mask.
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(6,14,24,0.82)';
    ctx.fillRect(0, 0, s, s);

    // Everything from here is drawn in world-aligned coordinates; the canvas
    // rotation below is what puts the direction of travel at the top.
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.rotate(-heading);
    ctx.translate(-s / 2, -s / 2);

    // --- water south of the coast
    const coastY = s / 2 + this._px(COAST_Z - pz);
    ctx.fillStyle = 'rgba(26,62,84,0.85)';
    ctx.fillRect(-s, coastY, s * 3, s * 3);

    // --- district blocks
    for (const id of REGION_ORDER) {
      const r = REGIONS[id];
      const x0 = s / 2 + this._px(r.cx - TILE / 2 - px);
      const y0 = s / 2 + this._px(r.cz - TILE / 2 - pz);
      const side = this._px(TILE);
      ctx.strokeStyle = 'rgba(56,225,255,0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, y0, side, side);
      const density = r.buildings.density;
      if (density > 0.3) {
        ctx.fillStyle = `rgba(120,140,160,${0.06 + density * 0.12})`;
        ctx.fillRect(x0, y0, side, side);
      }
    }

    // --- runway
    const rx = s / 2 + this._px(RUNWAY.x - RUNWAY.length / 2 - px);
    const ry = s / 2 + this._px(RUNWAY.z - pz);
    ctx.strokeStyle = 'rgba(230,240,250,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx + (RUNWAY.length / RANGE) * s, ry);
    ctx.stroke();

    // --- landmarks
    ctx.fillStyle = 'rgba(180,140,255,0.9)';
    for (const L of LANDMARKS) {
      const lx = s / 2 + this._px(L.x - px);
      const ly = s / 2 + this._px(L.z - pz);
      ctx.fillRect(lx - 1.5, ly - 1.5, 3, 3);
    }

    // --- route: remaining gates joined by a line
    if (route?.length) {
      ctx.strokeStyle = 'rgba(56,225,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = checkpointIndex; i < route.length; i++) {
        const c = route[i];
        const cxp = s / 2 + this._px(c.x - px);
        const cyp = s / 2 + this._px(c.z - pz);
        if (!started) { ctx.moveTo(cxp, cyp); started = true; } else ctx.lineTo(cxp, cyp);
      }
      ctx.stroke();
      for (let i = checkpointIndex; i < route.length; i++) {
        const c = route[i];
        const cxp = s / 2 + this._px(c.x - px);
        const cyp = s / 2 + this._px(c.z - pz);
        const next = i === checkpointIndex;
        ctx.fillStyle = next ? '#38e1ff' : 'rgba(56,225,255,0.4)';
        ctx.beginPath();
        ctx.arc(cxp, cyp, next ? 4 : 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- rival
    if (rivalPosition) {
      const vx = s / 2 + this._px(rivalPosition.x - px);
      const vy = s / 2 + this._px(rivalPosition.z - pz);
      ctx.fillStyle = '#ff4d5a';
      ctx.beginPath();
      ctx.arc(vx, vy, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // --- the player, always centred and always pointing up
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(s / 2, s / 2 - 6);
    ctx.lineTo(s / 2 - 4.5, s / 2 + 5);
    ctx.lineTo(s / 2 + 4.5, s / 2 + 5);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // --- heading ring and north mark
    ctx.strokeStyle = 'rgba(56,225,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
    const northAngle = -heading - Math.PI / 2;
    const nx = s / 2 + Math.cos(northAngle) * (s / 2 - 9);
    const ny = s / 2 + Math.sin(northAngle) * (s / 2 - 9);
    ctx.fillStyle = '#ffb340';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);

    const label = document.getElementById('minimap-label');
    if (label && region) label.textContent = region.short ?? region.name ?? '';
  }
}
