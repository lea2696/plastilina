# Yoyó — estado y reanudación

Fuente de verdad: `PRD_YOYO.md`. Reglas de repo: `AGENTS.md`. Decisiones: `docs/yoyo/DECISIONS.md`. Evidencia: `docs/yoyo/QA_REPORT.md`.

## 2026-10-01 — Inicio

Línea base de Masa antes de tocar nada (Y-15): `pnpm typecheck` y `pnpm lint` exit 0; `pnpm test` 30/30; `pnpm test:e2e` 14 pasan + 1 omitido (long-run opt-in). Registro: `artifacts/qa/yoyo/baseline-e2e.log`.

Plan:

- **Fase 0 (en curso):** módulo headless en `src/yoyo/` — percepción (extracción de ancla, clasificadores lanzar/tirar), estabilizador del pivote, modelo reducido y estados, runtime determinista, generador de replays sintéticos con ruido y no-eventos, evaluación de precisión/recall/latencia, driver de mouse, grabador opt-in de landmarks. Gate: Y-S1..Y-S4 en sintético.
- **Fase 1:** página `/yoyo` (Vite multipágina), render three.js nuevo, audio procedural, calibración/encuadre, estados operativos, modo mouse, «Ajustes → Avanzado» con umbrales y grabación. Gate: criterios sintéticos Y-01..Y-15, build, `audit:dist`, preview → smoke → producción en `masa-web-demo`. Validación humana pendiente para Luis.
- Fases 2–4: no se implementan hasta tener feedback de Luis con su webcam.

Scripts nuevos: `pnpm test:yoyo` (unitarios del yoyó), `pnpm test:yoyo:replays` (corpus sintético + fixtures reales si existen, informe en `artifacts/qa/yoyo/replays.json`), `pnpm benchmark:yoyo` (costo de física y estabilidad de 10 min).

## 2026-10-01 — Fase 0 cerrada, fase 1 publicada (pendiente de validación humana)

- **Fase 0 (sintético).**
  - Y-S3 y Y-S4 cumplen.
  - Y-S1 cumple en la semilla fijada y es frágil entre semillas.
  - Y-S2 estricto no cumple (máx. 4 frames en 6 de 381 lanzamientos débiles).
  - Luis decidió avanzar con los gaps documentados. El detalle está en QA_REPORT.
- **Fase 1.**
  - Página `/yoyo` (Vite multipágina) con render three.js propio, audio procedural, encuadre con zona y omisión a los 10 s, estados operativos (mano perdida, borde, giro agotado, pausa, errores de cámara/WebGL/contexto), modo mouse, «Ver demo», «Ajustes → Avanzado» con todos los umbrales, grabación opt-in de landmarks con descarga explícita y exportación de métricas.
  - Cámara en modo opt-in `video-frame`: un cuadro, una inferencia.
  - Criterios sintéticos Y-01..Y-15 cumplen, salvo los gaps de gestos débiles con ruido (Y-02 a 1,5 ih/s, Y-04 a 0,8 ih/s) y un e2e flaky.
  - Publicada en https://masa-web-demo.vercel.app/yoyo (`dpl_FDMSJLRMqgybTRRCVZN5fqspiazQ`).
- **Próxima acción: Luis prueba con su webcam** siguiendo `docs/yoyo/WEBCAM_VALIDATION.md` y, si puede, graba y descarga un replay real.
  - Con eso se ajustan umbrales: tirón (`tug.minSpeedFactor`, `tug.minUpDelta`), banda de giro y preset sentado.
  - Recién después se decide la fase 2.
- **Pendientes técnicos.**
  - Cierre del `webServer` de Playwright (ver QA).
  - e2e `yoyo-advanced` flaky.
  - Detección de salida sólo por el borde inferior.
  - El yoyó cuelga bajo el piso mientras la mano está fuera por abajo.
  - Margen fino de Y-05 (2,99 cm contra 3).

## 2026-10-01 — Primer feedback real de Luis

Tracking bien; el yoyó no bajaba (clasificador 1/19 en su replay). Causas: preparación hacia arriba grande (0,17–0,43 ih) y desenfoque de 1–2 cuadros en bajadas rápidas. Ajustado (ver DECISIONS «Ajuste con el primer replay real»): 17/19 sentado, 16/19 de pie, sin falsos nuevos en sintético. Publicado en producción (`dpl_4TMPjfwn1xWLQSX7fCbxRDT9Sfdg`). Próximo: Luis reprueba; si grabás otro replay (idealmente con lanzamientos y tirones), lo sumo como fixture. Pendiente: arreglar el e2e del hook de cámara (modo `framing` transitorio).

## 2026-10-01 — Segundo feedback real: el tirón

Bajar mejoró; subir fallaba (4/14 tirones en el replay). Ajustado `tug` en config (bajada previa permitida, 70°, paso por cuadro escalado): 10/14, con 4 tirones falsos en 300 clips casuales sintéticos como costo declarado. En producción (`dpl_53DRVxz8jpk32odePmW3QoFF8sWz`). Sin e2e por pedido de Luis. Próximo: reprueba de Luis; si sigue raro, contar qué hace el yoyó al volver (no se detecta / vuelve solo / vuelve raro).
