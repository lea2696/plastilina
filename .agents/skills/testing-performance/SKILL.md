---
name: testing-performance
description: Ejecutar suites y benchmarks con capacidades identificadas, fixtures reproducibles y resultados honestos.
---
# Cuándo
Agregar AC, fixtures, medición, E2E, verify o investigar regresiones.
# Entradas y procedimiento
Leer PRD 9 y docs/PROGRESS.md. Usar semillas/timestamps fijos y la misma interfaz de input. Ejecutar assets, typecheck, lint, unit, physics, E2E, benchmark, build y registrar exit codes. Etiquetar sintético, video autorizado/webcam, GPU identificada y prueba humana. Si falta capacidad, skipped: capability-unavailable; no sustituirla por mock. Medir render+tracking+física+superficie, no solo solver. Capturas con viewport fijo y revisión visual.
# Comandos/evidencia
pnpm verify; pnpm audit:dist; pnpm benchmark; LONG_QA_SECONDS=600 pnpm exec playwright test tests/e2e/long-run.spec.ts (fixture opcional de 10 min); artifacts/qa; docs/QA_REPORT.md. Verificar que verify falle ante suites fallidas y reporte no disponible por separado.
# Fallos frecuentes
Ocultar stderr; actualizar snapshots ciegamente; confundir headless software con GPU del usuario; umbrales rebajados para verde; pruebas que no ejercen ruta real.
