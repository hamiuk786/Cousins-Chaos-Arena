import React, { useEffect, useRef } from 'react';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BalloonSnapshot,
  GameEvent,
  getReadableTextColor,
  KICK_RANGE,
  RoomSnapshot,
  SLAP_RANGE,
} from '../../shared/protocol';
import { ArenaGameClient } from '../lib/gameClient';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  alpha: number;
  life: number;
  maxLife: number;
  rotation: number;
  vRot: number;
  kind: 'confetti' | 'shred' | 'spark';
}

interface RingEffect {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  life: number;
  maxLife: number;
  lineWidth: number;
}

interface FloatingLabel {
  x: number;
  y: number;
  vy: number;
  text: string;
  subtext?: string;
  color: string;
  life: number;
  maxLife: number;
}

interface ArenaCanvasProps {
  client: ArenaGameClient;
  snapshot: RoomSnapshot | null;
  myPlayerId: string | null;
  activeTool: 'THROW' | 'KICK';
  eventsQueueRef: React.MutableRefObject<GameEvent[]>;
  onKick: (dx: number, dy: number, power: number, targetBalloonId?: string | null) => void;
  onThrow: (dx: number, dy: number, power: number) => void;
}

const CONFETTI_PALETTE = ['#D94848', '#2563EB', '#0F766E', '#D97706', '#C59B27', '#DB2777', '#059669'];

export const ArenaCanvas: React.FC<ArenaCanvasProps> = ({
  client,
  snapshot,
  myPlayerId,
  activeTool,
  eventsQueueRef,
  onKick,
  onThrow,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(snapshot);
  const myPlayerIdRef = useRef<string | null>(myPlayerId);
  const activeToolRef = useRef<'THROW' | 'KICK'>(activeTool);

  snapshotRef.current = snapshot;
  myPlayerIdRef.current = myPlayerId;
  activeToolRef.current = activeTool;

  const particlesRef = useRef<Particle[]>([]);
  const ringsRef = useRef<RingEffect[]>([]);
  const labelsRef = useRef<FloatingLabel[]>([]);

  // Pointer drag state for swipe-and-release THROW or tap-to-KICK
  const dragRef = useRef<{
    active: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    currX: number;
    currY: number;
    startedAt: number;
  } | null>(null);

  const hoverWorldRef = useRef<{ x: number; y: number } | null>(null);

  const spawnEffectsForEvent = (ev: GameEvent) => {
    const particles = particlesRef.current;
    const rings = ringsRef.current;
    const labels = labelsRef.current;

    if (ev.type === 'HIT') {
      rings.push({
        x: ev.x,
        y: ev.y,
        radius: 18,
        maxRadius: 56,
        color: ev.color || '#D97706',
        life: 0,
        maxLife: 0.34,
        lineWidth: 3.5,
      });
      for (let i = 0; i < 8; i++) {
        const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.4;
        const speed = 110 + Math.random() * 140;
        particles.push({
          x: ev.x,
          y: ev.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 4 + Math.random() * 3,
          color: ev.color || '#D97706',
          alpha: 1,
          life: 0,
          maxLife: 0.38,
          rotation: 0,
          vRot: 0,
          kind: 'spark',
        });
      }
      if (ev.points && ev.points > 0) {
        labels.push({
          x: ev.x,
          y: ev.y - 26,
          vy: -58,
          text: `+${ev.points}`,
          subtext: ev.attackerName ? ev.attackerName : undefined,
          color: '#0F5132',
          life: 0,
          maxLife: 1.0,
        });
      }
    } else if (ev.type === 'POP') {
      rings.push({
        x: ev.x,
        y: ev.y,
        radius: 16,
        maxRadius: 96,
        color: ev.color || '#DC2626',
        life: 0,
        maxLife: 0.48,
        lineWidth: 5,
      });
      // Balloon shreds
      for (let i = 0; i < 16; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 130 + Math.random() * 240;
        particles.push({
          x: ev.x,
          y: ev.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 40,
          size: 6 + Math.random() * 6,
          color: ev.color || '#DC2626',
          alpha: 1,
          life: 0,
          maxLife: 0.75 + Math.random() * 0.35,
          rotation: Math.random() * Math.PI * 2,
          vRot: (Math.random() - 0.5) * 10,
          kind: 'shred',
        });
      }
      // Celebratory confetti burst
      for (let i = 0; i < 24; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 70 + Math.random() * 210;
        particles.push({
          x: ev.x,
          y: ev.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 90,
          size: 5 + Math.random() * 5,
          color: CONFETTI_PALETTE[i % CONFETTI_PALETTE.length],
          alpha: 1,
          life: 0,
          maxLife: 1.15 + Math.random() * 0.5,
          rotation: Math.random() * Math.PI * 2,
          vRot: (Math.random() - 0.5) * 12,
          kind: 'confetti',
        });
      }
      labels.push({
        x: ev.x,
        y: ev.y - 30,
        vy: -52,
        text: ev.isEliminated ? `POP! ELIMINATED (+${ev.points ?? 20})` : `POP! +${ev.points ?? 20}`,
        subtext: ev.victimName ? `${ev.victimName} popped by ${ev.attackerName ?? ''}` : undefined,
        color: '#B91C1C',
        life: 0,
        maxLife: 1.5,
      });
    } else if (ev.type === 'RESPAWN') {
      rings.push({
        x: ev.x,
        y: ev.y,
        radius: 54,
        maxRadius: 14,
        color: '#0F5132',
        life: 0,
        maxLife: 0.45,
        lineWidth: 3,
      });
      labels.push({
        x: ev.x,
        y: ev.y - 32,
        vy: -42,
        text: `${ev.victimName ?? 'Player'} Back!`,
        subtext: '2s Shield',
        color: '#0F5132',
        life: 0,
        maxLife: 1.2,
      });
    } else if (ev.type === 'SLAP') {
      rings.push({
        x: ev.x,
        y: ev.y,
        radius: 26,
        maxRadius: SLAP_RANGE,
        color: ev.color || '#0F5132',
        life: 0,
        maxLife: 0.32,
        lineWidth: 3,
      });
    } else if (ev.type === 'SHIELD_BLOCK') {
      rings.push({
        x: ev.x,
        y: ev.y,
        radius: 30,
        maxRadius: 68,
        color: '#C59B27',
        life: 0,
        maxLife: 0.35,
        lineWidth: 4,
      });
      labels.push({
        x: ev.x,
        y: ev.y - 32,
        vy: -45,
        text: 'BLOCKED',
        color: '#A16207',
        life: 0,
        maxLife: 0.85,
      });
    } else if (ev.type === 'LAST_SURVIVOR') {
      for (let i = 0; i < 45; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 100 + Math.random() * 260;
        particles.push({
          x: ev.x,
          y: ev.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 120,
          size: 6 + Math.random() * 6,
          color: CONFETTI_PALETTE[i % CONFETTI_PALETTE.length],
          alpha: 1,
          life: 0,
          maxLife: 1.7 + Math.random() * 0.6,
          rotation: Math.random() * Math.PI * 2,
          vRot: (Math.random() - 0.5) * 14,
          kind: 'confetti',
        });
      }
      labels.push({
        x: ev.x,
        y: ev.y - 44,
        vy: -36,
        text: `LAST SURVIVOR +${ev.points ?? 30}`,
        subtext: ev.attackerName,
        color: '#A16207',
        life: 0,
        maxLife: 2.2,
      });
    }
  };

  // Coordinate conversion helper (canvas CSS px -> 1200x800 world coords)
  const screenToWorld = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * ARENA_WIDTH;
    const y = ((clientY - rect.top) / rect.height) * ARENA_HEIGHT;
    return { x, y };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const snap = snapshotRef.current;
    const myId = myPlayerIdRef.current;
    if (!snap || snap.status !== 'PLAYING' || snap.isPaused || !myId) return;
    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      pointerId: e.pointerId,
      startX: world.x,
      startY: world.y,
      currX: world.x,
      currY: world.y,
      startedAt: performance.now(),
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) return;
    hoverWorldRef.current = world;
    if (dragRef.current && dragRef.current.active && dragRef.current.pointerId === e.pointerId) {
      dragRef.current.currX = world.x;
      dragRef.current.currY = world.y;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !drag.active) return;

    const snap = snapshotRef.current;
    const myId = myPlayerIdRef.current;
    if (!snap || snap.status !== 'PLAYING' || snap.isPaused || !myId) return;

    const balloons = client.getInterpolatedBalloons(performance.now());
    const mine = balloons.find((b) => b.playerId === myId);
    if (!mine || mine.status !== 'alive') return;

    const endWorld = screenToWorld(e.clientX, e.clientY) ?? { x: drag.currX, y: drag.currY };
    const swipeDx = endWorld.x - drag.startX;
    const swipeDy = endWorld.y - drag.startY;
    const swipeLen = Math.hypot(swipeDx, swipeDy);

    // Swipe & release (> 24 world px drag) => THROW in swipe direction
    if (swipeLen >= 24 && activeToolRef.current === 'THROW') {
      const power = Math.min(1, Math.max(0.3, swipeLen / 220));
      onThrow(swipeDx, swipeDy, power);
      return;
    }

    // If user swiped in KICK mode, kick in swipe direction (or kick targeted balloon if tapped)
    if (swipeLen >= 24 && activeToolRef.current === 'KICK') {
      const power = Math.min(1, Math.max(0.35, swipeLen / 200));
      onKick(swipeDx, swipeDy, power, null);
      return;
    }

    // Tap / Click: check if user clicked directly on an opponent balloon within KICK_RANGE
    let clickedOpponent: BalloonSnapshot | null = null;
    for (const b of balloons) {
      if (b.playerId === myId || b.status !== 'alive') continue;
      const hitDist = Math.hypot(endWorld.x - b.x, endWorld.y - b.y);
      if (hitDist <= b.radius + 16) {
        const distFromMe = Math.hypot(b.x - mine.x, b.y - mine.y);
        if (distFromMe <= KICK_RANGE + b.radius + mine.radius) {
          clickedOpponent = b;
          break;
        }
      }
    }

    if (clickedOpponent) {
      const dx = clickedOpponent.x - mine.x;
      const dy = clickedOpponent.y - mine.y;
      onKick(dx, dy, 0.92, clickedOpponent.balloonId);
    } else {
      // Directional kick launch toward tapped point
      const dx = endWorld.x - mine.x;
      const dy = endWorld.y - mine.y;
      if (Math.hypot(dx, dy) > 8) {
        onKick(dx, dy, 0.85, null);
      }
    }
  };

  // Main 60 FPS Canvas Rendering Loop
  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();

    const drawArenaBackground = (ctx: CanvasRenderingContext2D) => {
      // Sunlit alabaster pavilion court
      ctx.fillStyle = '#F6F3EC';
      ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

      // Subtle architectural floor grid
      ctx.strokeStyle = 'rgba(28, 25, 23, 0.045)';
      ctx.lineWidth = 1;
      const step = 80;
      for (let x = step; x < ARENA_WIDTH; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ARENA_HEIGHT);
        ctx.stroke();
      }
      for (let y = step; y < ARENA_HEIGHT; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(ARENA_WIDTH, y);
        ctx.stroke();
      }

      // Delicate pavilion court markings & center circle
      ctx.strokeStyle = 'rgba(15, 81, 50, 0.12)';
      ctx.lineWidth = 2;
      ctx.strokeRect(24, 24, ARENA_WIDTH - 48, ARENA_HEIGHT - 48);

      ctx.beginPath();
      ctx.arc(ARENA_WIDTH / 2, ARENA_HEIGHT / 2, 132, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(ARENA_WIDTH / 2, 24);
      ctx.lineTo(ARENA_WIDTH / 2, ARENA_HEIGHT - 24);
      ctx.strokeStyle = 'rgba(15, 81, 50, 0.07)';
      ctx.stroke();

      // Subtle corner flourishes
      const cornerSize = 26;
      ctx.strokeStyle = 'rgba(197, 155, 39, 0.35)';
      ctx.lineWidth = 2.5;
      const corners = [
        [24, 24, 1, 1],
        [ARENA_WIDTH - 24, 24, -1, 1],
        [24, ARENA_HEIGHT - 24, 1, -1],
        [ARENA_WIDTH - 24, ARENA_HEIGHT - 24, -1, -1],
      ];
      for (const [cx, cy, sx, sy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx, cy + sy * cornerSize);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * cornerSize, cy);
        ctx.stroke();
      }
    };

    const drawBalloon = (
      ctx: CanvasRenderingContext2D,
      b: BalloonSnapshot,
      isMine: boolean,
      nowSec: number,
      isKickTargetable: boolean,
    ) => {
      if (b.status !== 'alive') return;

      const r = b.radius;
      const rx = r;
      const ry = r * 1.08;
      const sway = Math.sin(nowSec * 3.1 + b.x * 0.02) * 4;

      ctx.save();
      ctx.translate(b.x, b.y);

      // Soft ground shadow beneath floating balloon
      ctx.fillStyle = 'rgba(28, 25, 23, 0.09)';
      ctx.beginPath();
      ctx.ellipse(3, ry + 14, rx * 0.65, 6, 0, 0, Math.PI * 2);
      ctx.fill();

      // Gently swaying ribbon string
      ctx.strokeStyle = 'rgba(87, 83, 78, 0.45)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, ry + 3);
      ctx.quadraticCurveTo(sway, ry + 16, -sway * 0.6, ry + 29);
      ctx.stroke();

      // Kick-targetable subtle dashed ring on hover/range
      if (isKickTargetable) {
        ctx.strokeStyle = 'rgba(185, 28, 28, 0.55)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(0, 0, ry + 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Own balloon subtle selection ring + YOU marker
      if (isMine) {
        ctx.strokeStyle = '#0F5132';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(0, 0, ry + 7, 0, Math.PI * 2);
        ctx.stroke();

        // Crisp downward pointer above your balloon
        ctx.fillStyle = '#0F5132';
        ctx.beginPath();
        ctx.moveTo(0, -ry - 10);
        ctx.lineTo(-6, -ry - 19);
        ctx.lineTo(6, -ry - 19);
        ctx.closePath();
        ctx.fill();
      }

      // Spawn Protection aura (2s after respawn)
      if (b.spawnProtected) {
        const pulse = 0.55 + 0.35 * Math.sin(nowSec * 12);
        ctx.strokeStyle = `rgba(15, 81, 50, ${pulse})`;
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(0, 0, ry + 11, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Active Shield protective ring
      if (b.shieldActive) {
        ctx.fillStyle = 'rgba(197, 155, 39, 0.16)';
        ctx.strokeStyle = '#C59B27';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(0, 0, ry + 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // Tied balloon knot
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.moveTo(-4, ry - 1);
      ctx.lineTo(4, ry - 1);
      ctx.lineTo(6, ry + 5);
      ctx.lineTo(-6, ry + 5);
      ctx.closePath();
      ctx.fill();

      // Main colorful balloon body (clean matte-satin shading, no cartoon character)
      const grad = ctx.createRadialGradient(-rx * 0.32, -ry * 0.34, rx * 0.12, 0, 0, ry * 1.15);
      grad.addColorStop(0, '#FFFFFF55');
      grad.addColorStop(0.28, b.color);
      grad.addColorStop(1, b.color);

      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();

      // Soft depth vignette on balloon edge
      const shadeGrad = ctx.createRadialGradient(-rx * 0.28, -ry * 0.3, rx * 0.1, 0, 0, ry * 1.05);
      shadeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.28)');
      shadeGrad.addColorStop(0.65, 'rgba(255, 255, 255, 0)');
      shadeGrad.addColorStop(1, 'rgba(0, 0, 0, 0.20)');
      ctx.fillStyle = shadeGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();

      // Crisp hairline balloon outline
      ctx.strokeStyle = 'rgba(28, 25, 23, 0.16)';
      ctx.lineWidth = 1.25;
      ctx.stroke();

      // Subtle natural highlight crescent
      ctx.fillStyle = 'rgba(255, 255, 255, 0.36)';
      ctx.beginPath();
      ctx.ellipse(-rx * 0.36, -ry * 0.34, rx * 0.16, ry * 0.28, -0.45, 0, Math.PI * 2);
      ctx.fill();

      // Prominent Cousin Name inside the balloon
      const textColor = getReadableTextColor(b.color);
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const maxWidth = rx * 1.66;
      const displayName = b.name;
      let fontSize = r >= 36 ? 14 : r >= 33 ? 13 : 11.5;
      ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;

      const words = displayName.split(' ');
      if (ctx.measureText(displayName).width <= maxWidth) {
        ctx.fillText(displayName, 0, 0, maxWidth);
      } else if (words.length >= 2) {
        const line1 = words[0];
        const line2 = words.slice(1).join(' ');
        fontSize = Math.max(10, fontSize - 1.5);
        ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText(line1, 0, -fontSize * 0.56, maxWidth);
        ctx.fillText(line2, 0, fontSize * 0.58, maxWidth);
      } else {
        while (fontSize > 9.5 && ctx.measureText(displayName).width > maxWidth) {
          fontSize -= 0.75;
          ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
        }
        ctx.fillText(displayName, 0, 0, maxWidth);
      }

      // Clean Health Bar directly beneath balloon
      const barW = rx * 1.35;
      const barH = 5;
      const barY = ry + 9;
      const hpRatio = Math.max(0, Math.min(1, b.health / b.maxHealth));

      ctx.fillStyle = 'rgba(28, 25, 23, 0.16)';
      ctx.beginPath();
      ctx.roundRect(-barW / 2, barY, barW, barH, 3);
      ctx.fill();

      ctx.fillStyle = hpRatio > 0.55 ? '#15803D' : hpRatio > 0.25 ? '#D97706' : '#DC2626';
      ctx.beginPath();
      ctx.roundRect(-barW / 2, barY, barW * hpRatio, barH, 3);
      ctx.fill();

      ctx.restore();
    };

    const renderFrame = (nowPerf: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (nowPerf - lastTime) / 1000));
      lastTime = nowPerf;
      const nowSec = nowPerf / 1000;

      // Consume queued authoritative game events -> visual effects
      if (eventsQueueRef.current.length > 0) {
        const batch = eventsQueueRef.current.splice(0, eventsQueueRef.current.length);
        for (const ev of batch) {
          spawnEffectsForEvent(ev);
        }
      }

      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetW = Math.round(ARENA_WIDTH * dpr);
        const targetH = Math.round(ARENA_HEIGHT * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);

          drawArenaBackground(ctx);

          const snap = snapshotRef.current;
          const myId = myPlayerIdRef.current;
          const balloons = client.getInterpolatedBalloons(nowPerf);
          const myBalloon = myId ? balloons.find((b) => b.playerId === myId) ?? null : null;

          // Subtle Kick range preview ring around own balloon during active play
          if (snap?.status === 'PLAYING' && !snap.isPaused && myBalloon && myBalloon.status === 'alive') {
            if (activeToolRef.current === 'KICK') {
              ctx.save();
              ctx.strokeStyle = 'rgba(15, 81, 50, 0.14)';
              ctx.lineWidth = 1.5;
              ctx.setLineDash([6, 6]);
              ctx.beginPath();
              ctx.arc(myBalloon.x, myBalloon.y, KICK_RANGE, 0, Math.PI * 2);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.restore();
            }
          }

          // Render opponent balloons first, then own balloon on top
          const hover = hoverWorldRef.current;
          for (const b of balloons) {
            if (b.playerId === myId) continue;
            let kickTargetable = false;
            if (
              snap?.status === 'PLAYING' &&
              !snap.isPaused &&
              myBalloon &&
              myBalloon.status === 'alive' &&
              hover
            ) {
              const distHover = Math.hypot(hover.x - b.x, hover.y - b.y);
              const distFromMe = Math.hypot(b.x - myBalloon.x, b.y - myBalloon.y);
              if (distHover <= b.radius + 16 && distFromMe <= KICK_RANGE + b.radius + myBalloon.radius) {
                kickTargetable = true;
              }
            }
            drawBalloon(ctx, b, false, nowSec, kickTargetable);
          }

          if (myBalloon) {
            drawBalloon(ctx, myBalloon, true, nowSec, false);
          }

          // Draw swipe-and-release aiming vector when dragging
          const drag = dragRef.current;
          if (drag && drag.active && myBalloon && myBalloon.status === 'alive') {
            const dx = drag.currX - drag.startX;
            const dy = drag.currY - drag.startY;
            const len = Math.hypot(dx, dy);
            if (len >= 14) {
              const clampedLen = Math.min(220, len);
              const nx = dx / len;
              const ny = dy / len;
              const endX = myBalloon.x + nx * clampedLen;
              const endY = myBalloon.y + ny * clampedLen;

              ctx.save();
              ctx.strokeStyle = '#0F5132';
              ctx.lineWidth = 3.5;
              ctx.setLineDash([8, 6]);
              ctx.beginPath();
              ctx.moveTo(myBalloon.x, myBalloon.y);
              ctx.lineTo(endX, endY);
              ctx.stroke();
              ctx.setLineDash([]);

              // Arrowhead
              const angle = Math.atan2(ny, nx);
              ctx.fillStyle = '#0F5132';
              ctx.beginPath();
              ctx.moveTo(endX, endY);
              ctx.lineTo(endX - 14 * Math.cos(angle - 0.4), endY - 14 * Math.sin(angle - 0.4));
              ctx.lineTo(endX - 14 * Math.cos(angle + 0.4), endY - 14 * Math.sin(angle + 0.4));
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            }
          }

          // Update & draw ring shockwaves
          const rings = ringsRef.current;
          for (let i = rings.length - 1; i >= 0; i--) {
            const ring = rings[i];
            ring.life += dt;
            if (ring.life >= ring.maxLife) {
              rings.splice(i, 1);
              continue;
            }
            const progress = ring.life / ring.maxLife;
            const curRadius = ring.radius + (ring.maxRadius - ring.radius) * progress;
            ctx.save();
            ctx.globalAlpha = 1 - progress;
            ctx.strokeStyle = ring.color;
            ctx.lineWidth = ring.lineWidth * (1 - progress * 0.5);
            ctx.beginPath();
            ctx.arc(ring.x, ring.y, Math.max(1, curRadius), 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }

          // Update & draw particles (sparks, balloon shreds, confetti)
          const particles = particlesRef.current;
          for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.life += dt;
            if (p.life >= p.maxLife) {
              particles.splice(i, 1);
              continue;
            }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.kind === 'confetti') {
              p.vy += 190 * dt; // soft confetti flutter gravity
              p.vx *= 0.97;
            } else if (p.kind === 'shred') {
              p.vy += 280 * dt;
              p.vx *= 0.96;
            } else {
              p.vx *= 0.93;
              p.vy *= 0.93;
            }
            p.rotation += p.vRot * dt;
            const alpha = Math.max(0, 1 - p.life / p.maxLife);

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rotation);
            ctx.fillStyle = p.color;
            if (p.kind === 'confetti') {
              ctx.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
            } else if (p.kind === 'shred') {
              ctx.beginPath();
              ctx.moveTo(-p.size * 0.6, -p.size * 0.3);
              ctx.lineTo(p.size * 0.6, 0);
              ctx.lineTo(-p.size * 0.2, p.size * 0.5);
              ctx.closePath();
              ctx.fill();
            } else {
              ctx.beginPath();
              ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          }

          // Update & draw floating score labels
          const labels = labelsRef.current;
          for (let i = labels.length - 1; i >= 0; i--) {
            const lbl = labels[i];
            lbl.life += dt;
            if (lbl.life >= lbl.maxLife) {
              labels.splice(i, 1);
              continue;
            }
            lbl.y += lbl.vy * dt;
            lbl.vy *= 0.95;
            const alpha = Math.max(0, 1 - Math.pow(lbl.life / lbl.maxLife, 1.8));
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '700 18px "JetBrains Mono", monospace';
            ctx.fillStyle = '#FFFFFF';
            ctx.lineWidth = 4;
            ctx.strokeStyle = 'rgba(255,255,255,0.92)';
            ctx.strokeText(lbl.text, lbl.x, lbl.y);
            ctx.fillStyle = lbl.color;
            ctx.fillText(lbl.text, lbl.x, lbl.y);
            if (lbl.subtext) {
              ctx.font = '600 12px "Plus Jakarta Sans", sans-serif';
              ctx.strokeText(lbl.subtext, lbl.x, lbl.y + 18);
              ctx.fillStyle = '#57534E';
              ctx.fillText(lbl.subtext, lbl.x, lbl.y + 18);
            }
            ctx.restore();
          }

          // Empty state message inside canvas before balloons are added
          if (snap && snap.balloons.length === 0) {
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#57534E';
            ctx.font = '600 22px "Fraunces", serif';
            ctx.fillText('Waiting for the Host to add cousins', ARENA_WIDTH / 2, ARENA_HEIGHT / 2 - 12);
            ctx.font = '400 15px "Plus Jakarta Sans", sans-serif';
            ctx.fillStyle = '#78716C';
            ctx.fillText('Once balloons are generated, every phone shares this exact arena.', ARENA_WIDTH / 2, ARENA_HEIGHT / 2 + 20);
            ctx.restore();
          }

          ctx.restore();
        }
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [client, eventsQueueRef]);

  const myBalloon = snapshot?.balloons.find((b) => b.playerId === myPlayerId) ?? null;
  const countdownNumber = snapshot?.status === 'COUNTDOWN' ? Math.max(1, Math.ceil(snapshot.countdownRemainingMs / 1000)) : null;

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-[3/2] max-h-[72vh] bg-[#F6F3EC] border border-[#E5E1D8] rounded-xl overflow-hidden select-none"
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        className="w-full h-full block touch-none cursor-crosshair"
      />

      {/* Synchronized Server Countdown Overlay */}
      {snapshot?.status === 'COUNTDOWN' && !snapshot.isPaused && countdownNumber !== null && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-[#FAF8F4]/65 backdrop-blur-[2px]">
          <p className="text-sm font-medium text-[#57534E] tracking-wide mb-2">
            Round {snapshot.roundNumber} begins in
          </p>
          <span className="font-display text-8xl font-bold text-[#0F5132] tabular-nums leading-none">
            {countdownNumber}
          </span>
        </div>
      )}

      {/* Paused Match Overlay */}
      {snapshot?.isPaused && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-[#1C1917]/45 backdrop-blur-[2px] px-6 text-center">
          <div className="bg-white border border-[#E5E1D8] rounded-xl px-8 py-6 max-w-md">
            <h3 className="font-display text-2xl font-semibold text-[#1C1917]">
              Match Paused
            </h3>
            <p className="text-sm text-[#57534E] mt-2">
              {snapshot.recoveredFromCheckpoint
                ? 'Restored from the latest server checkpoint. Waiting for the Host to resume.'
                : 'The Host paused the arena. Physics and timer are frozen.'}
            </p>
          </div>
        </div>
      )}

      {/* Owner's Personal Respawn Countdown Banner (non-blocking) */}
      {snapshot?.status === 'PLAYING' && !snapshot.isPaused && myBalloon?.status === 'respawning' && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#1C1917]/90 text-white px-5 py-3 rounded-lg text-center">
          <p className="text-xs text-[#D6D3D1]">First pop — returning with 2s spawn protection</p>
          <p className="font-mono text-lg font-semibold tabular-nums mt-0.5">
            Respawning in {(myBalloon.respawnRemainingMs / 1000).toFixed(1)}s
          </p>
        </div>
      )}

      {/* Eliminated Status Notice (after 2nd pop) */}
      {snapshot?.status === 'PLAYING' && !snapshot.isPaused && myBalloon?.status === 'eliminated' && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#1C1917]/90 text-white px-5 py-2.5 rounded-lg text-center">
          <p className="text-sm font-medium">
            Eliminated for Round {snapshot.roundNumber} · Watching live arena
          </p>
        </div>
      )}
    </div>
  );
};
