# Bayline Metro: SIM workstream status

Owner: sim workstream (branch `bart-sim`, worktree `.worktrees/bart-sim`, dev port 8136).
Files owned: `src/js/46_metrosim.js`, `src/js/47_metro*.js`, `tools/qa_metro_*.js`, `notes/bart/sim.md`,
`notes/bart/shots/sim/`, plus surgical integration edits in the shared files (`55_player.js`, `62_game.js`,
`66_ui.js`, `70_sound.js`, `80_net.js`, `90_main.js`, `src/head.html`, `server/mp.py` docs only).

## Status

- 2026-09-26 00:40: started. Read the plan, the Peninsula sim/player/game/UI/sound/net code. Designing the runtime
  against the MetroNet contract in `notes/bart-plan.md` (the data spec `notes/bart-data.md` is not out yet).

## Plan (in order)

1. Timetable runtime (`46_metrosim.js`, `MetroSim`): trips of the service day, deterministic from the clock,
   minimum-time speed profiles against civil limits, schedule smoothing, dwell, turnbacks, legs per vehicle
   (BART cars, the Antioch DMU, the airport people mover), near consists pooled, far trains as one instanced batch.
2. ATC and the drive game (`47_metroatc.js`): speed codes, manual mode under ATC supervision, ATO, scoring.
3. Player integration (ride, cab, drive, walk, chase/trackside/heli/orbit on metro trains, the Millbrae transfer).
4. UI (`47_metroui.js`): system map (schematic + geographic), station picker, arrivals, train info, line filter.
5. Audio (`47_metrosound.js`), multiplayer modes, live mode (`47_metrolive.js`), QA scripts.

Everything is behind `#metro=1`.
