# KILLHOUSE // SIM — Design Document

Sources: **FM 3-34.2** Combined-Arms Breaching Operations (SOSRA, ¶1-11 to 1-19), **ATP 3-21.8** Infantry Rifle Platoon and Squad (sectors of fire, interlocking fires, FPL), **FM 5-102** Countermobility (obstacles covered by fire, wire, mines), **ATTP 3-06.11** Combined Arms Operations in Urban Terrain (fatal funnel ¶7-52 and ¶7-99, stairwells ¶7-173).

---

## 1. Level selection & progression

* The menu shows all 16 levels at once in a 4×4 grid, one row per tier (EASY, MEDIUM, HARD, INSANE). Each card has a blueprint thumbnail of its map.
* Every level stays visible, but a level is locked until the level before it has been cleared once. Locked cards are greyed out with a padlock and a note such as "CLEAR LEVEL 4 TO UNLOCK".
* Cleared levels stay replayable. Each card shows the best grade (S/A/B/C), and PERFECT (breach) or FLAWLESS (defense) once that rating is earned.

### A. Unlock logic — `src/progression.js`

```js
/** Level N is unlocked iff N is the first level or level N-1 has been cleared. */
export function isUnlocked(levelId) {
  if (UNLOCK_ALL) return true;          // ?unlockall dev flag
  if (levelId === 0) return true;
  return isCleared(levelId - 1);
}

/** Every level is returned (visible), each with its lock state. */
export function levelStatuses() {
  return LEVELS.map((lvl) => {
    const res = getResult(lvl.id);
    let status = 'locked';
    if (isUnlocked(lvl.id)) status = res && res.cleared ? 'cleared' : 'available';
    return { level: lvl, status, bestGrade: res?.bestGrade, perfect: !!res?.perfect,
             lockReason: status === 'locked' ? `Clear Level ${lvl.id} to unlock` : null };
  });
}

/** Beating level X marks it cleared — exactly what isUnlocked(X + 1) checks. */
export function recordResult(levelId, { win, grade, time, perfect }) {
  const prev = save.results[levelId] || { cleared: false, bestGrade: null, bestTime: null, perfect: false, attempts: 0 };
  const wasNextUnlocked = isUnlocked(levelId + 1);
  prev.attempts += 1;
  if (win) {
    prev.cleared = true;
    if (!prev.bestGrade || GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(prev.bestGrade)) prev.bestGrade = grade;
    if (prev.bestTime == null || time < prev.bestTime) prev.bestTime = time;
    prev.perfect = prev.perfect || !!perfect;
  }
  save.results[levelId] = prev;
  persist();                                            // localStorage
  const next = levelId + 1;
  return { newlyUnlocked: win && next < LEVELS.length && !wasNextUnlocked && isUnlocked(next) ? next : null };
}
```

Because unlocking depends only on `cleared[N-1]`, beating Level X opens Level X+1 and leaves X+2 onward visible but locked. A loss still counts as an attempt but unlocks nothing.

---

## 2. Scaling difficulty

| Parameter | EASY: Basic Drills | MEDIUM: Coordinated | HARD: Fortified | INSANE: Meat Grinder |
|---|---|---|---|---|
| Defender reaction | **2.0 s** | 1.0 s | 0.55 s | 0.3 s |
| Base accuracy | 16 % | 24 % | 32 % | 42 % |
| Field of view | 70° (clear blind spots, ±25° sloppy sectors) | 100° | 110° | 120° |
| Crossfire | none: at most one man per door | 30–110° crossing | **45–90° interlocking** | 45–90°, every portal covered ×2 |
| Fatal-funnel lock | off | ×1.7 accuracy, ½ reaction | ×1.8 | ×2.0 |
| Shift when compromised | no | no | **yes** | yes |
| SOSRA violation | casualty | casualty | **instant failure** | instant failure |
| Extra obstacles | none (no booby traps) | none | +8 % wire density, +1 claymore | +14 % wire, +2 claymores |
| Mortar TRPs | — | — | — | **zeroed-in zones** outside |
| Bunching | chokepoints | chokepoints | chokepoints | **anywhere** = squad wipe |
| Attacker smoke / bounding (defense) | 0 / no | 1 per wave / yes | 2 / yes | 3 / yes |

Rules that never change with tier: suppression pins accuracy to **5 %**. Reduction takes **3 s** (iron barricades 5 s). The overpressure stun lasts **1.5 s**. Barbed wire cuts speed by **80 %**. Bunching means **more than 2 units** in a chokepoint for **more than 1.5 s**. Smoke has a 3.6 m radius and lasts 15 s.

### B. Difficulty state machine — `src/difficulty.js`

```
                ┌──────────────────────────────────────────────────────────┐
 level picked → │ BOOT → CONFIGURE_AI → SHAPE_OBSTACLES → PLAN_FIRES → ARMED │ → simulation
                └──────────────────────────────────────────────────────────┘
 tier input:  EASY ──► MEDIUM ──► HARD ──► INSANE   (TIER_PARAMS[tier] + in-tier ramp)
```

```js
step() {
  switch (this.state) {
    case 'BOOT':            // validate tier
      this.state = 'CONFIGURE_AI'; break;
    case 'CONFIGURE_AI': {  // tier params, then sharpen later levels inside the tier
      const base = TIER_PARAMS[this.level.tier];
      const k = this.level.id % 4;
      this.params = { ...base,
        reaction: base.reaction * (1 - 0.06 * k),       // AI reaction time
        accuracy: base.accuracy * (1 + 0.05 * k) };
      this.state = 'SHAPE_OBSTACLES'; break;
    }
    case 'SHAPE_OBSTACLES': // obstacle density: seeded wire + claymores in the approach band
      shapeObstacles(this.map, this.params, this.level.id);
      if (!this.params.mortars) this.map.mortar.fill(0);
      this.state = 'PLAN_FIRES'; break;
    case 'PLAN_FIRES':      // crossfire angles: automated ATP 3-21.8 fire plan
      this.plan = buildFirePlan(this.map, this.params, say, this.level.id);
      this.state = 'ARMED'; break;
  }
}
```

**Automated fire plan (`buildFirePlan`).** This is the DEFENDER SYSTEM.

1. **Window guards.** A defender next to a window faces out through it, so it overlooks the door approach.
2. **Machine-gun pairs.** The planner works out the friendly avenue of approach (A* from the player's spawn to the nearest outside breach point, widened by ±2 tiles). For each pair of guns it picks an aim point K on that corridor where both guns have line of sight and the crossing angle of their lines of fire falls inside `crossAngle`, preferring 67.5°. Both guns get K as their principal direction of fire.
3. **Riflemen (fatal-funnel lockdown).** Each rifleman picks a portal (door, breach wall or barricade) it can see. EASY never doubles up on a portal. MEDIUM and above reward a second coverer whose line crosses the first one's inside the band. INSANE wants two coverers on every portal.
4. **EASY sloppiness.** Sectors get a random yaw error, which leaves blind spots.

The briefing screen prints the state machine's log, for example `MG pair (7,9)×(29,9) interlocking at 68° over grid (15,16) ✓`. It also draws every sector line and crossing point on the map.

**Live defender AI** (per unit, `game.updateDefender`): `HOLD` → (target in its sector) → `ACQUIRE` (reaction timer; halved when the target stands in a fatal funnel) → `ENGAGE` (bursts) → `SEARCH` (looks at the last known position for 3 s) → `HOLD`. Overlays apply in any state: `STUNNED` (no fire, no turning) and `SUPPRESSED` (accuracy 5 %, slower cadence). On HARD and above, a defender becomes `COMPROMISED` when it has been suppressed for more than 1.2 s, a nearby ally dies, or a blast goes off in its room. It then `SHIFT`s: it scores tiles within 5 by hiddenness from the threat, adjacent cover and distance, paths there with A*, and re-faces the threat.

---

## 3. Breacher system (SOSRA, FM 3-34.2)

When you press **E** at an obstacle, the sim looks at the reduction area: the breach point plus 2.5 m of approach behind it. An **overwatcher** is any enemy that is alive, not stunned, and has line of sight to that area.

| | Satisfied when |
|---|---|
| **S**uppress | every overwatcher is suppressed (a teammate on a `G` suppress order, your own fire, any near-miss) **or** can't see through smoke |
| **O**bscure | there are no overwatchers, or smoke is within 12 m, or at least one overwatcher is blinded |
| **S**ecure | a teammate you are not controlling is within 14 m of the breach, holding a sector that faces away from it |
| **R**educe | the 3 s / 5 s channel finishes without you moving, then a 1.2 s fuse |
| **A**ssault | you cross the opening within the **1.5 s overpressure window** |

A live five-chip HUD tracker shows the state of each letter before you commit. Because you control one soldier at a time, SOSRA is a sequence of hand-offs: put one soldier on a suppress order, throw smoke, leave another holding the flank, then switch to the breacher.

### Fatal errors (hard-coded)

* **Unsuppressed overwatch.** Setting a charge while an overlooking window or position is neither suppressed nor obscured gets the nearest squad member shot instantly (EASY and MEDIUM). On HARD and INSANE, any missing S, O or Secure is an **instant mission failure** ("SOSRA VIOLATION").
* **Bunching.** Three or more friendlies within 2 m of a chokepoint (door, breach, barricade or stairs) for 1.5 s, while any defender has line of sight to it, triggers a **CROSSFIRE WIPE**. On INSANE, any 3-man cluster anywhere has the same effect.
* **Mortar TRPs (INSANE).** Spending more than 1 s observed in a pre-registered zone without smoke brings a round with a 1.6 s warning ring, and the rounds keep coming while you stay.
* **Claymores.** Entering the 120° front arc kills everyone in the blast cone. Disarm one from behind with **E**.

---

## 4. Level list

| # | Tier | Mode | Name | Teaches |
|---|---|---|---|---|
| 1 | Easy | Breach | Single Door Drill | single entry, charge, stun window |
| 2 | Easy | Breach | Window Watch | suppress/obscure the overlooking window |
| 3 | Easy | Breach | Overwatch Tower | elevation beats low cover |
| 4 | Easy | Defense | Hold The Line | sectors of fire, interlocking |
| 5 | Medium | Breach | The Fatal Funnel | multi-room crossfire, no bunching |
| 6 | Medium | Breach | Courtyard Gate | MG + window over a gate |
| 7 | Medium | Breach | Mezzanine | stairs are funnels, plunging fire |
| 8 | Medium | Defense | Crossroads | two avenues, enemy smoke |
| 9 | Hard | Breach | Wire Obstacle | full SOSRA on a wire belt, MG pair |
| 10 | Hard | Breach | Compound Raid | mutually supporting buildings, shifting AI |
| 11 | Hard | Breach | Hardpoint | make your own entry (breach wall) |
| 12 | Hard | Defense | Firebase | tie fires into the wire |
| 13 | Insane | Breach | The Meat Grinder | mortar TRPs, barricades |
| 14 | Insane | Breach | Citadel | keep inside compound, tower MG |
| 15 | Insane | Breach | Last Bastion | everything |
| 16 | Insane | Defense | Final Protective Line | four waves, MG attackers |
