# QA — 2026-09-30

## Iteración 2026-10-01 (4): material arcilla, fricción, agarre, filtro 1€

Sintético, sin webcam humana. typecheck, lint, 30/30 unit (nuevos: fricción crece con presión; hendidura conserva >60% —medido 72%—; soltar pinza según apertura guardada), 14/14 E2E (captura de mouse muestra hendidura y pliegue persistentes), stability 72.000 pasos volumen 0,023611–0,023717 minY 0,003, benchmark 1,90 ms/paso, topology 14 activos / 8 en reposo (FALLA, AC-10 abierto; antes 7/6). Test de palmas mide ahora el ancho en la banda que aprietan las palmas: con plasticidad real la masa escapa por debajo, cerca de la mesa.


## Iteración 2026-10-01 (3): agarre

Sintético, sin webcam humana. typecheck, lint, 27/27 unit, 14/14 E2E, topology 7 activos / 6 en reposo (sin cambio), benchmark 1,84 ms/paso.


## Iteración 2026-10-01 (2): UI mínima y toque permisivo

Sintético, sin webcam humana. `pnpm typecheck`, `pnpm lint`: pasan. `pnpm test`: 26/26 (nuevo: la ayuda de profundidad apoya la mano a 9 cm sin empujar —contactCount 0, contacto registrado— y no mueve una mano a 30 cm). `pnpm test:e2e`: 14/14 tras mover los controles secundarios a "Ajustes" (helper `tests/e2e/ui.ts`). Construcción de la interacción con ayuda: 0,88 ms/frame con dos manos cerca (M4, Node). Capturas locales de inicio y demo revisadas. Solver sin cambios en esta iteración: topology sigue en 6 cruces en reposo (AC-10 abierto).


## Iteración 2026-10-01: interacción mano-masa y modo mouse

Todo sintético; webcam humana NO probada (Luis la probará). Equipo: Apple M4, Chrome headless ANGLE Metal.

- `pnpm typecheck`, `pnpm lint`: pasan.
- `pnpm test`: 25/25. Los tests físicos tenían índices fijos de malla n=5 y 4/8 fallaban también con el solver de Codex en n=6 (nunca se corrieron en n=6); se hicieron independientes de la resolución. Nuevos: hendidura de punta entre vértices (contacto contra caras), pinza sin pulgar/dedo sólidos, puño, profundidad por tamaño con mano de tamaño constante, herramienta mouse.
- `pnpm test:e2e`: 14 pasan (long-run omitido por defecto). Nuevo `mouse.spec.ts`: presionar y agarrar con mouse, `grasps:1`, sin tets invertidos ni errores de consola. `performance.spec` necesitó calibrar las manos QA sintéticas sobre la masa (el modelo de profundidad deja una mano sin calibrar delante de la masa).
- `pnpm test:stability`: 72.000 pasos, volumen 0,023669–0,023710, minY 0,003.
- `pnpm benchmark`: 1,81 ms/paso (Codex n=6: 2,73 sin las nuevas funciones).
- Retención de hendidura tipo mouse (script local, 3,8 cm a 4,5 cm de profundidad, 2 s de reposo): 49% (antes 25%). AC-06 pide ≥50% en su fixture, que pasa.
- `pnpm test:topology` FALLA: 7 cruces activos / 6 en reposo, 0 tets invertidos, volumen estable. Con el solver de Codex en n=6 daba 0 porque su agarre no plegaba la masa (0 autocontactos en el fixture); con agarre firme el pliegue extremo ocurre y aparecen cruces. AC-10 sigue abierto.


## Iteración actual: más deformación, sin pruebas funcionales

Petición explícita: tracking ya correcto según Luis, mejorar interacción/plasticidad y entregar producción sin pruebas funcionales. Revisión de código e implementación: arrastre tangencial, palma amplia, oposición de varios dedos, anclas locales orientadas, plasticidad local, n=6 fijo, contactos efectivos en render. `pnpm typecheck`, `pnpm lint`, `pnpm assets:verify`, `pnpm build` y `pnpm audit:dist` exit 0. Cinco assets de manifest verificados; diez archivos en dist, cota de variante 17,5959 MiB, sin patrones de secretos/rutas personales. Build y prebuilt static coinciden por SHA256. Warning Vite de chunk >500 kB y warnings deprecación de Node, no errores.

Omitidos por petición del usuario, NO aprobados: unit/tracking/physics, topology, stability, E2E, audio offline, benchmark, verify, interacción sintética y webcam real de la nueva iteración. Se revisó únicamente disponibilidad remota HTTP, sin activar cámara, replay ni controles. Se intentó apertura pasiva, pero IAB/Chrome CUA no disponibles: UI/render inicial/consola no comprobados. AC-06 a AC-12 y AC-17 requieren nueva evidencia tras cambios de solver/n=6. AC-10 sigue abierto: el dato de cuatro cruces pertenece a n=5 anterior, no se ha medido el número actual. No se presenta esta iteración como v1 ni como validación funcional. Resultados que siguen son históricos.

Disponibilidad publicada: preview real `dpl_CwaTKHp6fc8G3BaMcXBQdJM71i5X` comprobado antes de producción; producción `dpl_2ZWSUboYvk1KFHqPjVvGmsxP6kFy` Ready/promovida a https://masa-web-demo.vercel.app. Diez archivos públicos HTTP 200 anónimos, MIME esperado, SHA256 exacto de dist, CSP/Permissions-Policy/nosniff conservados. En preview el HTML tiene toolbar añadida de plataforma tras HTML original; resto de assets exactos. Scripts de disponibilidad no interactúan con app ni ejecutan física. Evidencias locales: `artifacts/qa/deformation-preview-availability.json`, `deformation-production-availability.json`, `deformation-release.json`. Source SHA256 sin commit `5dc50070a69c1a83b42817c68da2bc7d07c1869bc32991295bfcf07425d029a4`. Sin push ni secretos en bundle/registro; .env efímeros de pull eliminados.

Evidencias distintas, no intercambiables: colisionadores 3D guionados; HandFrame sintético/replay; inferencia MediaPipe con cámara falsa de Chrome (sin manos reales); rendimiento headless con GPU WebGL identificada; el usuario sí probó webcam real en la versión anterior, reportó tracking correcto pero manipulación/caída deficientes. No hay métricas ni captura de esa prueba humana. `pnpm verify` no convierte estas últimas dos en pruebas aprobadas.

- AC-01 parcial: build Vite y E2E Chrome cargan modelo/WASM/worker HTTP 200 e inferencia positiva; URL pública y recursos remotos HTTP 200; webcam humana pendiente.
- AC-02 parcial: rechazo de permiso, NotFoundError de cámara ausente y grant tardío tras cancelación probados en E2E; desconexión de hardware físico no probada.
- AC-03 parcial: contrato de 21 puntos y dos manos sintéticas; inferencia de dos manos humanas pendiente.
- AC-04 parcial: orden de resultados intercambiado preserva IDs; mano ausente se elimina de inmediato y cruce ambiguo corta IDs; cruces/oclusiones reales pendientes.
- AC-05 parcial: fixture con jitter estático sembrado: RMS filtrado 74,0% menor que crudo; salto de 0,08 normalizado sigue 54,4% en el primer frame de 16 ms. Retardo de cámara-a-pantalla y subjetivo con mano real pendientes.
- AC-06: fixture 120 Hz prueba efecto remoto cero y presión residual >50% tras 3 s; mano real pendiente.
- AC-07: palmas guionadas comprimen con redistribución lateral, error de volumen <10%, penetración vértice-esfera <0,03D; mano real pendiente.
- AC-08: dos anclas superficiales estiran un extremo >0,15 m con extremo opuesto <0,05 m; sin atracción remota; mano real pendiente.
- AC-09: agarre cercano eleva, liberación cae y apoya con y>=0, volumen <10%; mano real pendiente.
- AC-10 FALLA: 20 pliegues con volumen <10% y máximo una inversión tetra durante un paso, pero auditoría independiente de pares de triángulos no vecinos encontró 7 cruces activos y 4 persistentes tras 360 pasos de reposo. Capturas crudas y suavizadas abiertas muestran solapa/cavidad visible; Loop no corrige topología. `pnpm test:topology` falla deliberadamente. Faltan autocontacto robusto y aceptación visual.
- AC-11: volumen medido sobre shell triangular cerrada, no masa declarada; diferencia de volumen visual Loop <1% en fixture. Casos extremos pendientes.
- AC-12 parcial: señales >180 ms o mano ausente ya no aplican fuerzas; pérdida real mientras se sostiene pendiente.
- AC-13: ocultar pestaña pausa y resetea acumulador/audio; E2E.
- AC-14: intro y omisión convergen a estado de estudio, probadas en E2E; apreciación humana pendiente.
- AC-15 parcial: prueba Web Audio OfflineAudioContext 44,1 kHz/1 s: idle peak 0, contacto peak 0,01788, mute peak 0. E2E confirma cues procedurales de intro y controles de volumen/silencio sin cámara. Sonoridad/comodidad humana pendiente.
- AC-16: 20 ciclos de inicio/paro con cámara falsa terminan tracks/worker; no recaptura automática. Webcam real pendiente.
- AC-17 parcial: 600,9 s Chrome headless, cámara falsa + inferencia MediaPipe + dos manos sintéticas + contacto/física/superficie/render: 599 muestras, mediana 60 FPS, p95 de p95 móviles de frame 16,8 ms, p99 de p99 móviles 16,8 ms, p95 de edad de landmarks 51 ms; 0 tetra invertidos, volumen estable. No equivale a percentiles exactos de todos los frames ni a webcam humana. Se ejecutó antes del último ajuste de calidad adaptativa/audio UI; E2E breve de build final conserva 60 FPS, p95 16,7/p99 16,8, inferencia 17 ms, edad 36 ms y WebGL `ANGLE (Apple, ANGLE Metal Renderer: Apple M4)`. `artifacts/qa/browser-long-run.json` y `browser-performance.json`.
- AC-18: errores inducidos de WebGL ausente/pérdida de contexto y modelo inválido muestran estado recuperable; E2E.
- AC-19 parcial: assets con SHA/licencia, CSP local compatible, `dist/` auditado sin patrones comunes de secretos/rutas personales; tráfico E2E mismo origen/GET sin POST. Suma observada de tamaños de respuesta en preview local 14,95 MiB; Playwright subreportó cuerpo del worker (303 bytes incluyendo headers), por lo que es cota inferior. Cota conservadora de variante WASM seleccionada en dist 17,59 MiB crudos (<35 MiB). Headers remotos CSP, Permissions-Policy y nosniff verificados. `artifacts/qa/browser-transfer.json`.
- AC-20 falló parcialmente según usuario en la versión anterior: webcam detectó las manos correctamente, pero manipulación de masa y caída al soltar no parecían funcionar. Tras corrección de mapeo y agarre falta repetir prueba humana; comodidad no evaluada.

`pnpm test:stability` completó 72.000 pasos (10 min simulados) en ~180 s de pared, volumen 0,0233979→0,0233943 m³, mínimo y=0,003 m; dedo sintético, sin render ni tracking. `pnpm benchmark` mide solver+superficie aislados, no experiencia completa. Capturas `artifacts/qa/initial-studio.png`, `synthetic-demo.png`, `fold-active.png`, `fold-rested.png`, `fold-active-smooth.png` y `fold-rested-smooth.png` fueron inspeccionadas visualmente; no se consideran acabado final.

La última verificación integral `pnpm verify` terminó exit 1 por `test:topology: FAIL` (4 cruces persistentes); los demás gates pasaron: assets, typecheck, lint, 18 unit tests (8 físicas), 72.000 pasos de estabilidad, audio offline, benchmark, build, auditoría dist y 13 E2E. Tras corregir un NaN de vértices de display descubierto remotamente, se ejecutaron typecheck, lint, 19 unit tests, build, audit y 13 E2E: todos pasaron; el gate de topología no cambió. La fixture de 10 minutos está opt-in y figura como 1 omitida en E2E normal; su corrida separada pasó. Resultado completo en `artifacts/qa/verify.log`. Se afinó después el texto final de verify para resumir automáticamente checks fallidos; typecheck/lint posteriores pasaron, sin alterar el fallo AC-10.

P0 fallido/pendiente antes de declarar v1: autocontacto AC-10 con cruces persistentes; contacto y comodidad con manos/webcam reales. La demo parcial https://masa-web-demo.vercel.app fue comprobada públicamente tras la corrección de NaN: raíz, JS, CSS, worker, modelo, WASM/loader SIMD y no-SIMD, favicon HTTP 200 con MIME esperado; cabeceras CSP/Permissions-Policy/nosniff. Playwright CLI abrió estudio, activó replay sintético, confirmó 60 FPS/p95 16,7 ms y verificó inferencia MediaPipe usando `getUserMedia` de canvas sintético (~18,3 ms), luego apagó cámara. No fue webcam real. La captura `artifacts/qa/remote-demo-public.png` se inspeccionó visualmente. Hubo mensajes de diagnóstico internos de MediaPipe/XNNPACK, no el spam NaN previo ni errores de app. Se conservó en pantalla el rótulo de demo experimental. Ver docs/DEPLOYMENT.md.

Iteración rápida 2026-09-30: revisión de código halló z de puntos cercana al centro de la masa, y de puntas demasiado alta respecto de la superficie. El chequeo de proximidad en cada paso hacía soltar anclas al levantar; ahora solo se exige proximidad al adquirir y se libera por apertura/pérdida. Se añadió tema oscuro por defecto y toggle. `pnpm typecheck`, `pnpm lint`, `pnpm assets:verify`, 8 tests de tracking y 8 físicos en corridas focales pasaron, al igual que `pnpm build` y `pnpm audit:dist`. Una suite completa posterior tuvo 3 timeouts físicos bajo carga alta del host (17/20 pasaron); no se alteraron límites ni solver. Primera E2E: 12 pasaron, 1 fallo de temporización en lectura de Diagnóstico tras visibilidad, 1 long-run omitida. Repetición focal bootstrap+lifecycle 3/3 pasó sin relajar condición. `pnpm test:topology` y `pnpm verify` no reejecutados; el fallo AC-10 conocido sigue abierto. Captura oscura local abierta e inspeccionada. Deployment `dpl_GdwGgvmGiznz3cnyGYwkGe2A5edg` verificado por HTTP y browser remoto; no se infiere éxito de interacción humana de estos checks. Próximo dato necesario: el usuario prueba presión, pinch/levantar y separación/caída en la URL pública actual.
