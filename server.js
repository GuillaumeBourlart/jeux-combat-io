import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

// -- Configuration --
const { PORT = 4000 } = process.env;
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// World & view
const worldSize = { width: 4000, height: 4000 };
const VIEW_WIDTH = 1920, VIEW_HEIGHT = 1080;

// Items
const MIN_ITEM_RADIUS = 4;
const MAX_ITEM_RADIUS = 10;
const ITEM_COLORS = [
  "#FF5733", "#33FF57", "#3357FF", "#FF33A8", "#33FFF5", "#FFD133", "#8B5CF6"
];
const INITIAL_ITEM_COUNT = 400;

// Level & health
const EXP_PER_LEVEL_BASE = 10;      // base exp needed per level
const HEALTH_PER_LEVEL = 2;         // max HP gained per level up
const ATTACK_BUFFER_MS = 100;       // extra ms cannot attack after hit

// Knockback
const KNOCKBACK_DISTANCE = 20;

// Utility functions
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
function clampPosition(pos) {
  return {
    x: clamp(pos.x, 0, worldSize.width),
    y: clamp(pos.y, 0, worldSize.height)
  };
}
function randomItemRadius() {
  return Math.floor(Math.random() * (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS + 1)) + MIN_ITEM_RADIUS;
}
function getItemValue(radius) {
  return Math.round(
    1 + ((radius - MIN_ITEM_RADIUS) / (MAX_ITEM_RADIUS - MIN_ITEM_RADIUS)) * 5
  );
}
function generateRandomItems(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const r = randomItemRadius();
    items.push({
      id: `item-${i}-${Date.now()}`,
      x: Math.random() * worldSize.width,
      y: Math.random() * worldSize.height,
      radius: r,
      value: getItemValue(r),
      color: ITEM_COLORS[Math.floor(Math.random() * ITEM_COLORS.length)]
    });
  }
  return items;
}
function dropItemsAt(x, y, count, room) {
  for (let i = 0; i < count; i++) {
    const r = randomItemRadius();
    room.items.push({
      id: `drop-${Date.now()}-${Math.random()}`,
      x, y,
      radius: r,
      value: getItemValue(r),
      color: ITEM_COLORS[Math.floor(Math.random() * ITEM_COLORS.length)],
      dropTime: Date.now()
    });
  }
}

// Game state
const rooms = {};

// Socket.IO
io.on("connection", socket => {
  console.log(`Client ${socket.id} connected`);

  // Assign to room 1 (simple: single room)
  const roomId = "room-1";
  if (!rooms[roomId]) {
    rooms[roomId] = {
      players: {},
      items: generateRandomItems(INITIAL_ITEM_COUNT)
    };
  }
  const room = rooms[roomId];
  socket.join(roomId);

  // Initialize player
  room.players[socket.id] = {
    x: Math.random() * worldSize.width,
    y: Math.random() * worldSize.height,
    direction: { x: 0, y: 0 },
    speed: 3,
    exp: 0,
    level: 1,
    maxHealth: 10,
    health: 10,
    canAttack: true,
    weapon: {
      damage: 3,
      size: 40,
      swingSpeed: 300  // ms duration
    }
  };

  // Receive movement direction (unit vector)
  socket.on("changeDirection", dir => {
    const p = room.players[socket.id];
    if (p) {
      const mag = Math.hypot(dir.x, dir.y) || 1;
      p.direction = { x: dir.x/mag, y: dir.y/mag };
    }
  });

  // Attack event
  socket.on("attack", () => {
    const p = room.players[socket.id];
    if (!p || !p.canAttack) return;
    p.canAttack = false;
    const now = Date.now();
    const endAttack = now + p.weapon.swingSpeed;

    // Check collision: simple front-arc hitbox
    const ux = p.direction.x;
    const uy = p.direction.y;
    const perp = { x: -uy, y: ux };
    const hitLength = p.weapon.size;
    const hitWidth = p.weapon.size / 2;

    for (const [otherId, o] of Object.entries(room.players)) {
      if (otherId === socket.id || o.health <= 0) continue;
      // relative vector
      const dx = o.x - p.x;
      const dy = o.y - p.y;
      // project onto forward and perp
      const forwardDist = dx*ux + dy*uy;
      const sideDist = Math.abs(dx*perp.x + dy*perp.y);
      if (forwardDist > 0 && forwardDist <= hitLength && sideDist <= hitWidth) {
        // hit
        o.health -= p.weapon.damage;
        // knockback
        o.x += ux * KNOCKBACK_DISTANCE;
        o.y += uy * KNOCKBACK_DISTANCE;
        const { x: cx, y: cy } = clampPosition(o);
        o.x = cx; o.y = cy;
        // disable attack for victim briefly
        setTimeout(() => {
          o.canAttack = false;
          setTimeout(() => { o.canAttack = true; }, ATTACK_BUFFER_MS);
        }, 0);

        // if killed
        if (o.health <= 0) {
          // drop items
          dropItemsAt(o.x, o.y, 5, room);
          // respawn as fresh player (or remove)
          delete room.players[otherId];
          io.to(otherId).emit("died");
        }
        break; // only one hit per attack
      }
    }

    // Reset attack availability
    setTimeout(() => { p.canAttack = true; }, p.weapon.swingSpeed + ATTACK_BUFFER_MS);
  });

  // Disconnect
  socket.on("disconnect", () => {
    delete room.players[socket.id];
  });
});

// Game loop: movement, item pickup
setInterval(() => {
  const room = rooms["room-1"];
  if (!room) return;

  // Move players & clamp
  for (const p of Object.values(room.players)) {
    p.x += p.direction.x * p.speed;
    p.y += p.direction.y * p.speed;
    const cl = clampPosition(p);
    p.x = cl.x; p.y = cl.y;
  }

  // Item pickup & level up
  for (const p of Object.values(room.players)) {
    for (let i = 0; i < room.items.length; i++) {
      const it = room.items[i];
      const dx = p.x - it.x, dy = p.y - it.y;
      if (Math.hypot(dx, dy) < (it.radius + 10)) {
        p.exp += it.value;
        room.items.splice(i, 1);
        // spawn new
        const r = randomItemRadius();
        room.items.push({ id: `item-${Date.now()}`,
          x: Math.random()*worldSize.width,
          y: Math.random()*worldSize.height,
          radius: r, value: getItemValue(r), color: ITEM_COLORS[Math.floor(Math.random()*ITEM_COLORS.length)]
        });
        i--;
      }
    }
    // level up check
    const needed = EXP_PER_LEVEL_BASE * p.level;
    if (p.exp >= needed) {
      p.exp -= needed;
      p.level += 1;
      p.maxHealth += HEALTH_PER_LEVEL;
      p.health = Math.min(p.health + HEALTH_PER_LEVEL, p.maxHealth);
    }
  }

  // Broadcast state
  const payload = {
    players: {},
    items: []
  };
  // visible entities per player would be filtered client-side
  for (const [id, p] of Object.entries(room.players)) {
    payload.players[id] = {
      x: p.x, y: p.y,
      health: p.health, maxHealth: p.maxHealth,
      exp: p.exp, level: p.level,
    };
  }
  payload.items = room.items;

  io.in("room-1").emit("gameState", payload);
}, 1000/60);

// HTTP route
app.get("/", (req, res) => res.send("Top-down combat game server running"));

httpServer.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
