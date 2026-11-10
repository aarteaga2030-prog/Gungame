# KILLHOUSE // SIM — Tactical Breach & Defense Simulator

A level-based tactical sandbox built on FM 3-34.2 (combined-arms breaching / SOSRA), ATP 3-21.8 (infantry platoon & squad: sectors of fire, interlocking fires, fatal funnel), FM 5-102 (countermobility: wire, claymores, obstacles covered by fire) and ATTP 3-06.11 (urban operations). It plays on a white "killhouse blueprint" grid with stairs, platforms, short walls, sandbags, crates, windows, doors, breach walls and iron barricades.

## Run it

It's a static site with no build step. Three.js r160 is in `lib/`, so it runs offline. The browser blocks loading `.glb` models from `file://`, so you need to serve the folder over HTTP:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

To play every level without unlocking them, open `http://localhost:8000/?unlockall`.

## Assets used

| File | Used as |
|---|---|
| `assets/german_bundeswehr_soldier_-_rigged.glb` | Blue squad soldiers (its mixamo idle frame is also retargeted onto the red rig) |
| `assets/rigged_and_textured_mid-poly_soldier.glb` | OPFOR soldiers |
| `assets/military_helmet.glb` | Helmet worn by OPFOR |
| `assets/nemesis_sniper_rifle.glb` | Everyone's rifle, fired semi-auto (one click, one round) |
| `assets/sandbags_-_defense_line.glb` | One segment per sandbag tile |

There are no walk animations in the assets, so walking legs and rifle-ready arms are posed procedurally (bone-aim solver in `src/assets.js`).

## Controls

You control **one soldier at a time**. Switch with `1`–`4` or `Tab`. The soldiers you're not controlling stay where you left them, cover the direction they were facing and fire at any enemy that enters that sector.

| Key | Action | SOSRA |
|---|---|---|
| WASD / mouse | move / aim the soldier you control (`Shift` walks) | |
| Click | fire one round (semi-auto; every shot is a click) | |
| `R` | reload | |
| `1`–`4`, `Tab` | take control of another squad member | |
| `G` | standing order: this soldier keeps suppressing the cursor point after you switch away (press again to cancel) | **S**uppress |
| `Q` | throw smoke at the cursor | **O**bscure |
| leave a teammate near the breach facing away from it | flank security | **S**ecure |
| `E` | reduce: breaching charge (3 s, iron 5 s), cut wire, disarm claymore | **R**educe |
| (move through within 1.5 s of the blast) | overpressure stun window | **A**ssault |
| `F` | open a door quietly (no stun) | |
| `V` / `Esc` | toggle sight fans / pause | |

In **defense** levels you first place the SAW, RFL and SEC and click to set each one's sector of fire, then emplace claymores. Press Enter to begin, then switch between soldiers as the waves come in.

## Code map

| File | What's in it |
|---|---|
| `src/progression.js` | **A.** level-unlock logic |
| `src/difficulty.js` | **B.** difficulty state machine, tier parameters, automated fire planner (interlocking MG pairs, fatal-funnel lockdown) |
| `src/game.js` | simulation: units, defender/attacker/squad AI, SOSRA checks, fatal errors, mortars, waves |
| `src/map.js` | grid, line of sight (DDA), cover, heights/stairs, A* |
| `src/world.js`, `src/fx.js` | blueprint visuals, smoke, tracers, sight fans |
| `src/levels.js` | 16 levels (4 per tier) as ASCII maps |

See **[DESIGN.md](DESIGN.md)** for the full design write-up (deliverables A and B).
