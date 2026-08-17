# Reference implementation (verified 2026-08-17)

`bridge.js` + `report.js` are the ad-hoc bridge that validated the full
integration end-to-end on a live Multica deployment (issue dispatch, web
chat, due-date routing, tri-state reporting, redispatch-on-delivery-failure,
idempotent re-register). The component's `src/index.js` should migrate this
logic per the solution doc (../solution.md), NOT rewrite it from scratch —
every protocol quirk in here was learned against the real server.
