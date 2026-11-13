# KILLHOUSE // SIM

A top-down tactical shooter on a white "killhouse blueprint" grid, for solo and online co-op play, plus an **AI vs AI** mode. You pick a **map**, a **mission** and the forces, and then you play or watch. There are no levels and no unlocks.

- **Breach:** your side assaults the building and the AI defends it.
- **Defend:** your side holds the building and the AI attacks it.
- **The enemy** ranges from a 4-man recruit fire team up to a full 13-man **Marine rifle squad** (squad leader plus three fire teams, each with an automatic rifleman and a grenadier).

You have full control of your soldier. Nothing is scripted. There are no instant-loss rules and no forced kills: rounds, grenades, charges and claymores do damage, and that's it.

The AI fights only from its **training** and its **senses**. Every AI force, at every difficulty, is trained on **1,098 of the 1,247 pages** of FM 3-34.2, ATP 3-21.8, FM 5-102 and ATTP 3-06.11. The pages left out are covers, contents, indexes, glossaries and blank pages. `src/manual.js` indexes every page by topic, and `src/doctrine.js` builds the AI's 25 drills from that coverage. You can browse the pages from the menu under **AI training**. It does not know the map layout or where you are. It builds its own map by looking around. It learns where you are by spotting you (which takes time), by hearing your shots and explosions (which gives a rough position) and by taking fire. See [DESIGN.md](DESIGN.md).

## Run it

```bash
node server.js          # http://localhost:8000. Serves the game and relays multiplayer.
```

No `npm install` is needed. `server.js` uses only Node's built-in modules, and three.js is vendored in `lib/`.

Any static server works for solo play (for example `python3 -m http.server`). Online play needs `server.js` or the published claude.ai artifact, which uses the artifact's `room` capability.

### Multiplayer

1. The host clicks **Host online game** and shares the 5-letter room code.
2. Other players type the code and click **Join**.
3. The host clicks **Start mission**. Everyone plays on the same side, and AI teammates fill in if you set any.

The game runs on the host's browser, and the others send their input and receive snapshots. If a player drops out, an AI takes over their soldier.

### AI vs AI

Choose **AI vs AI** on the menu, pick a **Blue force** and a **Red force** (any of the four, for example a Marine rifle squad against a Marine rifle squad) and choose whether blue attacks or defends. Then click **Watch**, or **Host online** so others can join the room and watch with you.

| Spectator key | Action |
|---|---|
| WASD / Wheel | pan / zoom |
| Tab | follow the next soldier |
| V | view everything, or only what blue or red can see |
| 1–4 | sim speed 1×, 2×, 4× or 8× (when watching solo) |

The forces panel shows each side's strength and the drill it is running, with its manual reference.

## Controls

| Key | Action |
|---|---|
| WASD, mouse | move, aim |
| Click | fire one round |
| R | reload |
| Shift / X or Ctrl | sprint / crouch (crouching makes you harder to spot and lets low cover stop more rounds) |
| E | open or close a door, cut wire (3 s), disarm a claymore (3 s) |
| F | set a breaching charge on a door, wall or barricade (3 s, barricade 5 s). Any wall can be blown. |
| G / Q | throw a frag / smoke at the cursor |
| C | place a claymore facing your aim (defending side) |
| Wheel / Esc | zoom / menu |

## Code map

| File | What's in it |
|---|---|
| `src/manual.js` | generated index of every manual page: reference, heading, topics (`tools/mkmanual.py` rebuilds it from the PDFs) |
| `src/doctrine.js` | training built from that index, the 25 drills (with manual references) and the four force profiles |
| `src/ai.js` | perception (belief map, spotting, hearing, incoming fire) and the doctrine behaviours |
| `src/sim.js` | authoritative simulation: movement, physical rounds, damage, grenades, smoke, charges, claymores, doors, outcomes |
| `src/maps.js`, `src/map.js` | the map catalog (terrain only) and the grid, line-of-sight and A* code |
| `src/view.js`, `src/world.js`, `src/fx.js` | rendering, including fog of war (enemies are only drawn while your side can see them) |
| `src/net.js`, `server.js` | multiplayer transport (artifact `room` or WebSocket relay) |
| `src/main.js`, `src/ui.js` | menus, lobby, HUD and the game loop |

## Assets

The squad uses the German soldier, the OPFOR uses the mid-poly soldier with the helmet, everyone carries the rifle (fired semi-auto), and the sandbag tiles use the sandbag model. All are in `assets/`. Walking and rifle-ready arms are posed in code because the models have no animations.
