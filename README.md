# KILLHOUSE // SIM

A top-down tactical shooter on a white "killhouse blueprint" grid, for solo and online co-op play. You pick a **map**, a **mission** and an **enemy force**, and then you play. There are no levels and no unlocks.

- **Breach:** your side assaults the building and the AI defends it.
- **Defend:** your side holds the building and the AI attacks it.
- **The enemy** ranges from a 4-man recruit fire team up to a full 13-man **Marine rifle squad** (squad leader plus three fire teams, each with an automatic rifleman and a grenadier).

You have full control of your soldier. Nothing is scripted. There are no instant-loss rules and no forced kills: rounds, grenades, charges and claymores do damage, and that's it.

The AI fights only from its **training** (doctrine "pages" taken from FM 3-34.2, ATP 3-21.8, FM 5-102 and ATTP 3-06.11; see `src/doctrine.js`) and its **senses**. It does not know the map layout or where you are. It builds its own map by looking around. It learns where you are by spotting you (which takes time), by hearing your shots and explosions (which gives a rough position) and by taking fire. See [DESIGN.md](DESIGN.md).

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
| `src/doctrine.js` | the AI's training pages (with manual references) and the four enemy-force profiles |
| `src/ai.js` | perception (belief map, spotting, hearing, incoming fire) and the doctrine behaviours |
| `src/sim.js` | authoritative simulation: movement, physical rounds, damage, grenades, smoke, charges, claymores, doors, outcomes |
| `src/maps.js`, `src/map.js` | the map catalog (terrain only) and the grid, line-of-sight and A* code |
| `src/view.js`, `src/world.js`, `src/fx.js` | rendering, including fog of war (enemies are only drawn while your side can see them) |
| `src/net.js`, `server.js` | multiplayer transport (artifact `room` or WebSocket relay) |
| `src/main.js`, `src/ui.js` | menus, lobby, HUD and the game loop |

## Assets

The squad uses the German soldier, the OPFOR uses the mid-poly soldier with the helmet, everyone carries the rifle (fired semi-auto), and the sandbag tiles use the sandbag model. All are in `assets/`. Walking and rifle-ready arms are posed in code because the models have no animations.
