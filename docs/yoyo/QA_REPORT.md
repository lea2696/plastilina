# Yoyó — QA

Cada evidencia se etiqueta por tipo y no se mezclan: **sintético** (replays generados, mouse guionado, Node), **cámara falsa** (Chrome `--use-fake-device-for-media-stream`: carga e inferencia de MediaPipe, sin manos), **GPU headless** (Chrome headless con WebGL identificado), **webcam real** y **humano**. Ninguna evidencia sintética cuenta como validación con webcam o humana.

## Línea base de Masa (Y-15), 2026-10-01, antes de cambios

Sintético. `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` 30/30 (5 archivos); `pnpm build` y `pnpm test:e2e` 14 pasan, 1 omitido (long-run opt-in). Equipo: Apple M4, Chrome estable (canal `chrome`) headless.

## Fase 0 — spike de percepción y modelo (2026-10-01)

Todo **sintético** (Node, Apple M4). Sin cámara falsa, sin GPU, sin webcam real ni prueba humana en esta fase. Comandos: `pnpm test:yoyo`, `pnpm test:yoyo:replays` (gates, `artifacts/qa/yoyo/replays.json`), `pnpm benchmark:yoyo` (`artifacts/qa/yoyo/benchmark.json`).

Corpus (semilla fija 20261001, definida antes de medir): 400 lanzamientos (1,5–3 ih/s, subida 40–80 ms, 20 % sale por abajo), 400 tirones (0,8–1,6 ih/s en 100–200 ms, con o sin balanceo previo), 300 clips de no-eventos de 4–8 s (saludar, reacomodarse ≤ 0,6 ih/s, rascarse la cara, arcos 0,5–1,8 ih/s, inclinaciones, glitches de tracking, quieta), 18 clips largos (8 × 60 s con tirón armado: jitter, balanceo, glitches; 10 × 5 s quieta con lanzamiento armado) y 200 clips de estrés informativos. Ruido según §8.2: jitter común σ = 0,5 % del ancho, 0,15 % extra por landmark, 2 % en tamaño de palma, 3 % de frames perdidos con ráfagas, 50 ms + 0–10 ms de retraso, fase aleatoria, glitches de salto/tamaño/z, salida por el borde inferior.

| Criterio | Resultado (semilla fija) | Estado |
|---|---|---|
| Y-S1 lanzar | precisión 100 % (381 VP, 0 FP), recall 95,3 % | cumple |
| Y-S1 tirar | precisión 100 % (354 VP, 0 FP), recall 88,5 % | cumple |
| Y-S1 0 disparos en no-eventos | 0 en los no-eventos consistentes y 0 en los 18 clips largos (incluye 60 s de jitter y 60 s de balanceo) | cumple con la aclaración de abajo |
| Y-S2 latencia ≤ 2 frames | tirones: máx. 2 frames (p50 1); lanzamientos: p50 2, p95 2, **máx. 4** (6 de 381 por encima) | **no cumple (KNOWN GAP)** |
| Y-S3 sleeper 60 s con balanceo | 5 semillas × 2 variantes (config por defecto con relanzamientos; sleeper literal con τ = ∞): sin NaN, L − L_max = 0 mm, ω ≤ 660 rad/s, nunca por encima del pivote con mano realista | cumple |
| Y-S4 determinismo | mismo guion → secuencia de estados idéntica bit a bit (modelo); pipeline completo: ver runtime | cumple (modelo) |

Aclaraciones y evidencia que no se esconde:

- **Y-S1 y la regla literal del PRD.** 110 de los 300 clips casuales cumplen, **sin ruido**, la regla literal de tirón (≥ 0,04 ih en 3 frames tras quietud): son tirones por definición. En el set completo hay 24 disparos de tirón (0,71 por minuto de movimiento casual); los 24 caen en esos 110 clips. Antes de agregar evidencia extra al clasificador eran 42 (1,24/min). El gate se aplica a los no-eventos que la regla literal no marca (oráculo sobre la trayectoria limpia, sólo con reglas del PRD).
- **Robustez entre semillas (no es gate).** Con 10 semillas: precisión y recall cumplen en 10/10 (tirar: recall 85,3–88,5 %, el mínimo pegado al 0,85); clips largos en silencio 10/10; **«0 disparos» en no-eventos consistentes sólo en 2/10** (0–6 tirones falsos por 300 clips, media 2,7 ≈ 0,08 por minuto de movimiento casual); Y-S2 máximo ≤ 2 en 0/10 semillas (máx. 3–4 frames, 5–14 detecciones tardías de ~720). La semilla fija está en el extremo favorable.
- **Por qué Y-S2 no cierra.** La regla literal de lanzar (dos intervalos seguidos ≥ 1,2 ih/s) no tiene margen: sin ruido ya dispara a 1 frame en 148 de 400 clips y a 2 frames en 222. En los 6 tardíos, el jitter baja uno de los primeros intervalos rápidos a 0,9–1,2 ih/s y el par se completa 1–2 frames después. Cerrarlo pide una decisión de PRD (regla u onset), no ajuste fino. La lectura por media se evaluó y no cumple la regla de adopción fijada antes de medir.
- **Lanzamiento con salida por abajo.** Recall en esos clips 95 % (82 % antes de completar el lanzamiento al desaparecer la mano).
- **Pivote.** Retraso de 3,6–4,2 cm a 1 m/s (≈ 36 ms) con los parámetros del §4.2; jitter estático 47 % del crudo; datos > 180 ms: velocidad exactamente 0; recuperación sin teletransporte (≤ 4,4 cm por cuadro más allá de lo que se mueve la mano, límite 5).
- **Modelo.** α sin pérdidas 68,52 rad/s² (fórmula exacta a 1e-12); con pérdidas 62,3 / 56,3 rad/s² a 380 / 750 rad/s. Bajada 0,28 s (fuerte) a 0,53 s (débil), +1,9 % sobre la analítica. Sobrepaso en fin de cuerda 0 mm. Decaimiento del sueño: error máx. 5e-14 contra ω₀·e^(−t/τ). Propiedades: 1500 episodios realistas + 1000 caóticos, 15 M de pasos, error de cuerda tensa ≤ 0,34 %, sin NaN; nunca por encima del pivote con mano realista (con mano caótica sí, se informa).
- **Costo y estabilidad.** Física por cuadro (4 pasos + pivote): p95 0,33 µs en Node (presupuesto 1,5 ms). 10 min a 240 Hz × 3 semillas: sin NaN, error de largo ≤ 0,26 %, L − L_max = 0 mm, 73–82 ciclos lanzar-atrapar por semilla.
- **Preset sentado** (informativo): ver DECISIONS; tirones falsos 0 en clips quietos pero recall 61 % con movimientos × 0,7.

Decisión de Luis (2026-10-01): avanzar a la fase 1 con Y-S2 y la fragilidad de Y-S1 documentadas; sus replays reales decidirán el ajuste. `pnpm test:yoyo:replays` sigue saliendo con código 1 mientras Y-S2 falle; la suite unitaria queda verde porque el gap está fijado con `it.fails` (si alguien lo arregla, ese test se pone rojo y avisa).

### Runtime headless: escenarios Y-01..Y-11 sintéticos (`pnpm test:yoyo:scenarios`, `artifacts/qa/yoyo/scenarios.json`)

Sintético: sesiones con el ruido de §8.2 (o guion de mouse sin ruido) pasadas por el runtime completo (extractor → clasificador → pivote → modelo, paso fijo 240 Hz con tope 4, render simulado a 60 Hz). 65 checks: 60 pasan, 5 gaps conocidos declarados (`it.fails`, el script y la suite se ponen rojos el día que se cierren), 0 fallas.

| Criterio | Resultado sintético |
|---|---|
| Y-01 atado | 24/24 atan 436–715 ms (p50 476) después del último movimiento > 1 cm; 0 pasos de física antes; 0 atados en 5 s de mano moviéndose; con zona, nunca fuera de ella. Cumple. |
| Y-02 lanzar | Guionados sin ruido a 1,5/2,25/3 ih/s: 36/36 en ≤ 2 frames; 0 lanzamientos en 5 s quieto. Con ruido, todo el rango: 94,3 % llegan a rodando, p95 2 frames. **Gap:** a 1,5 ih/s con ruido sólo 70 % y p95 4 frames. |
| Y-03 sleeper | 10/10 duermen; L ≤ L_max + 0,000 mm; ω sigue ω₀·e^(−t/τ) (error ~0). Cumple. |
| Y-04 tirón | Con ruido 0,8–1,6 ih/s: 88,7 % vuelven; inicio→decisión p50 52 ms, p95 75 ms; 0 tirones en 3 × 60 s de jitter. **Gaps:** a 0,8 ih/s con ruido 71 %; 2 de 36 guionados sin ruido (0,8 ih/s en 100 ms, justo en el borde de 0,04 ih) rechazados por la evidencia extra `tug.minSpeedFactor`; 3 de 337 decisiones tardías (máx. 135 ms) todas por dos cuadros de cámara perdidos seguidos dentro del gesto. |
| Y-05 retorno | 371/371 atrapados y re-atados, distancia máx. 2,99 cm (límite 3, margen fino); sin saltos (desplazamiento acotado por la velocidad pico de los pasos del cuadro: exceso 0,000 mm). Cumple. |
| Y-06 mano perdida | Nada dispara sin mano; velocidad del pivote 0 con datos > 180 ms; reaparición a 0,3–0,6 ih: teletransporte máx. 4,56 cm (límite 5); sin NaN. Cumple. |
| Y-07 borde | 24/24 salidas por abajo (0,5–1,5 ih/s): borde 'bottom' en todos los snapshots de la ausencia, fase mantenida, el pivote nunca termina más allá de la última muestra por más de |v|·33 ms + 1 cm (máx. 1,78 cm). Cumple (viñeta: ver e2e). |
| Y-08 giro agotado | Alcanzable con auto-retorno apagado y con la mano ausente; un tirón lo enrolla y atrapa. Cumple. |
| Y-09 estabilidad | 10 min simulados a 240 Hz con sesiones en bucle y cortes de render inyectados: 0 no finitos, cola máx. 5 de 8, error de cuerda tensa máx. 0,075 %, tiempo descartado contabilizado. Cumple. |
| Y-11 paridad mouse | Mismo guion por mouse y por cámara sin ruido: misma secuencia de fases y eventos 12/12 (atado → rodando → durmiendo → enrollando → atrapado → atado). Cumple (headless; Playwright: ver e2e). |
| Y-S4 pipeline completo | Mismo replay dos veces (también ida y vuelta por archivo JSON): diferencia 0 en 777 snapshots. Cumple. |

Latencia del tirón con ruido: captura→llegada p50 55 ms (50 ms simulados + inferencia), inicio→procesado p50 108 ms, llegada→cambio de fase ≤ 4,1 ms, visible en el cuadro siguiente ≤ 16,6 ms. Las pérdidas de mano se cuentan sólo si duran ≥ 300 ms (tres cuadros perdidos seguidos dejan la última muestra con 188 ms y la física se detiene, como debe, pero no es una pérdida para las métricas).

## Fase 1 — núcleo jugable en /yoyo (2026-10-01)

Equipo: Apple M4, Chrome 154 (canal `chrome`) headless, WebGL «ANGLE (Apple, ANGLE Metal Renderer: Apple M4)». **No hubo webcam real ni prueba humana**: esas columnas quedan pendientes para Luis (`docs/yoyo/WEBCAM_VALIDATION.md`).

Tipos de evidencia de esta fase, por separado:

- **Sintético (Node):** `pnpm test` (incluye Masa y yoyó), `pnpm test:yoyo`, `pnpm test:yoyo:scenarios`, `pnpm test:yoyo:replays`, `pnpm benchmark:yoyo`, `pnpm test:yoyo:audio` (audio offline en Chrome headless).
- **Sintético (navegador):** Playwright con puntero guionado, «Ver demo» (replay sintético por el camino HandFrame), páginas de falla, ajustes y audio.
- **Cámara falsa:** Chrome `--use-fake-device-for-media-stream`: permiso, carga e inferencia real de MediaPipe en el worker (sin manos).
- **Cámara falsa + manos sintéticas:** `/yoyo?qa=camera-replay` (hook opt-in, rotulado en pantalla «QA · manos sintéticas»): el camino real de cámara (cámara falsa, MediaPipe, `requestVideoFrameCallback`, encuadre, runtime, grabador, viñeta), con los landmarks reemplazados por una sesión sintética validada. No es una mano real.
- **GPU headless:** rendimiento medido en Chrome headless sobre la GPU del M4; no representa una GPU integrada lenta.

| ID | Condición sintética | Evidencia (tipo) | Estado sintético | Humano |
|---|---|---|---|---|
| Y-01 | Ata ≤ 1 s tras mano estable, nunca antes, sin física previa | Runtime: 24/24, 436–715 ms tras el último movimiento, 0 pasos antes (sintético). Navegador: mouse ata 411–419 ms tras el clic; cámara falsa + manos sintéticas: ata 867–961 ms tras aparecer el contorno (400 ms de entrada + 400 ms estable) | cumple | pendiente |
| Y-02 | Lanzamiento guionado 1,5–3 m/s en ≤ 2 frames; 0 falsos en 5 s quieto | Guionados sin ruido 36/36 en ≤ 2 frames; 0 en 5 s quieto (runtime y navegador). Con ruido: 94,3 % del rango, p95 2 frames | cumple guionado; **gap con ruido a 1,5 ih/s** (70 %, p95 4 frames) | pendiente |
| Y-03 | Duerme, ω según la curva, L ≤ L_max + 1 mm | Runtime 10/10, L − L_max = 0 mm, error de curva ~0; navegador: sleeper visible (2 900–3 500 px de yoyó en pantalla) | cumple | pendiente (zumbido) |
| Y-04 | Flick ≥ 0,8 m/s en ≤ 200 ms → retorno en ≤ 100 ms; 0 retornos en 60 s de jitter | 88,7 % del rango con ruido, inicio→decisión p95 75 ms; 0 tirones en 3 × 60 s de jitter; navegador: tirones del puntero 100 % | **gaps**: 0,8 ih/s con ruido 71 %; 2/36 guionados de 0,8 ih/s en 100 ms rechazados; 3/337 decisiones > 100 ms (máx. 135) por dos cuadros de cámara perdidos | pendiente |
| Y-05 | Vuelve a < 3 cm y se re-ata, sin saltos | 371/371 atrapados, máx. 2,99 cm (margen fino), exceso de desplazamiento 0,000 mm; navegador: atrapado → atado en las 3 vueltas del puntero | cumple | pendiente |
| Y-06 | > 180 ms sin fuerza ni disparos; sin teletransporte > 5 cm; sin NaN | Runtime: pivote con velocidad 0 exacta, teletransporte máx. 4,56 cm. Cámara falsa + manos sintéticas: una pérdida, píldora «Mano perdida», sin disparos, se recupera y completa la segunda vuelta | cumple | pendiente |
| Y-07 | Mano 0,5 s fuera por abajo: extrapolación acotada, estado mantenido, viñeta | Runtime 24/24 con borde 'bottom' todo el tiempo y extrapolación ≤ |v|·33 ms + 1 cm; cámara falsa + manos sintéticas: viñeta encendida 37 cuadros (~0,95 s), texto exacto, fase 'sleeping' mantenida. Mientras la mano está fuera por abajo el yoyó cuelga bajo el piso (sigue al pivote) y vuelve al aparecer la mano | cumple | pendiente |
| Y-08 | Giro agotado definido | Runtime y navegador: «Giro agotado · tirá para enrollar» se sostiene; tirón → enrollando → atrapado; no responsivo: «Giro agotado · sin retorno» | cumple | pendiente |
| Y-09 | 10 min a 240 Hz sin NaN, error de largo < 2 %, tope de pasos, colas acotadas | Benchmark 3 × 10 min: error ≤ 0,26 %; runtime 10 min con cortes de render: 0 no finitos, cola máx. 5/8, error 0,075 % | cumple | — |
| Y-10 | Física ≤ 1,5 ms p95; frame p95 ≤ 16,8 ms; intención→render ≤ 100 ms medida | GPU headless, puntero 22 s: frame p95 16,7–16,8 ms (sin margen), física p95 0,1 ms, render p95 0,4 ms, intención→render p50 16 / p95 17 ms. Demo: 55–73 ms incluyendo los 50–60 ms de tracking simulado. Cámara falsa + manos sintéticas: p50 60–69 / p95 78–86 ms, captura→llegada p50 23–31 ms, inferencia 17–20 ms. Con webcam real se suma la latencia propia de la cámara, que no se puede medir sin hardware | cumple (GPU rápida, sin webcam) | pendiente («me sigue») |
| Y-11 | Paridad mouse: Y-02..Y-05 por puntero | Playwright: 3 vueltas seguidas atado → rodando → durmiendo → enrollando → atrapado → atado; las primeras 12 fases iguales a las de la demo y la cámara de QA; corrida opt-in de 60 vueltas sin reintentos | cumple | pendiente («usable sin cámara») |
| Y-12 | Sin requests con frames o landmarks; sin persistencia; grabación sólo por descarga explícita | 10 requests en sesiones de cámara, puntero y demo: todos GET al mismo origen de archivos estáticos, sin cuerpo, sin websocket ni beacon; localStorage, sessionStorage, IndexedDB, cookies, Cache Storage y service workers vacíos. Grabador: ninguna descarga antes del clic, exactamente una después; `yoyo-replay/1` con 134 cuadros, sólo `t`, `a`, `h`, `lm`, sin `data:` ni base64; `parseReplay` lo vuelve a leer | cumple | — |
| Y-13 | — | — | — | pendiente (5 min sin dolor; preset sentado) |
| Y-14 | El flujo llega a «atado» sin intervención | Cámara falsa + manos sintéticas: del clic en «Comenzar con cámara» al atado sin otra acción; sin mano, a los 10 s el encuadre se omite solo | cumple | pendiente (persona nueva ≤ 60 s) |
| Y-15 | Suites de Masa siguen pasando; `/` sin cambios funcionales | Ver «Verificación final» abajo | ver abajo | — |

Notas:

- **Flakiness de los e2e del yoyó:** tres series de 3 corridas; una sola falla aislada en la serie B (un lanzamiento del puntero no leído en el test de rendimiento, no reproducible en 28 repeticiones). Playwright manda un evento de mouse por cuadro (~16,6 ms); con pasos de 35 px se perdía ~1 de 20 lanzamientos y una reproducción offline de esos eventos por el driver y el clasificador también lo perdía, así que es un límite real del gesto (arrastre de pocos cuadros), no del test. Los gestos usan 50 px por evento y el test principal exige cero reintentos.
- **Audio offline:** silencio exacto sin desbloquear, en pausa, silenciado y en atado/agotado; secuencia completa con pico 0,34 a volumen por defecto (peor caso 0,96 a volumen 1); el tono del zumbido sube 100 → 270 Hz de 150 a 1000 rad/s. Ningún `AudioContext` antes del primer clic (Playwright).
- **Render:** 6–8 draw calls; render CPU p95 0,05 ms sin vsync; GPU 0,3–0,6 ms por cuadro a 1–4 MP en el M4; sin crecimiento de geometrías/texturas/programas en 20 000 cuadros; pérdida y restauración de contexto verificadas.

### Verificación final y publicación (2026-10-01)

- `pnpm assets:verify`, `pnpm typecheck`, `pnpm lint`: exit 0. `pnpm test`: 55 archivos, 1294 tests (Masa 30 + yoyó), todos pasan. `pnpm build` y `pnpm audit:dist` exit 0: 14 archivos, 17,78 MiB por variante WASM (límite 35), `index.html` y `yoyo.html` con CSP y todas sus referencias presentes, sin patrones de secretos.
- **`pnpm test:e2e` completo (Masa + yoyó), una corrida de 15,4 min: 44 pasan, 2 omitidos (opt-in), 1 falla.** Las 14 pruebas de Masa pasan (**Y-15 cumple**: `/` sin cambios funcionales; su bundle conserva el nombre `index-*.js` y el mismo worker). La falla es `yoyo-advanced` («Sentado» + un lanzamiento por puntero): el lanzamiento no se leyó en 3 intentos y la traza muestra eventos `blur`/`focus` de la página al comenzar; pasó en todas las corridas del agente de e2e. Se registra como **flaky del arnés de puntero, no resuelto**.
- **El servidor de Playwright no termina solo.** `vite preview`, lanzado vía `pnpm preview`, queda huérfano en otro grupo de procesos y retiene la salida, así que Playwright imprime los resultados pero no termina hasta matar ese proceso a mano. Corregido después: `webServer.command` usa `node_modules/.bin/vite preview --host 127.0.0.1 --port 4173` y Playwright termina y libera el puerto.
- `pnpm test:yoyo:replays` sigue saliendo con 1 a propósito (Y-S2 estricto, KNOWN GAP). `pnpm test:yoyo:scenarios`, `pnpm benchmark:yoyo` y `pnpm test:yoyo:audio` exit 0 en sus últimas corridas.
- **Publicación** (ver `docs/DEPLOYMENT.md`): preview real `https://masa-web-demo-oyxsjepgw-luis-projects-4c3ecf2c.vercel.app` (target Preview, Ready). Recursos con HTTP 200, MIME correcto y SHA-256 idéntico a `dist`, salvo el HTML de `/`, que en preview trae la toolbar de Vercel. Producción staged `dpl_FDMSJLRMqgybTRRCVZN5fqspiazQ` (target production) promovida a **https://masa-web-demo.vercel.app/yoyo**. En el alias público, 10 recursos con HTTP 200 anónimo, MIME correcto y SHA-256 idéntico a `dist`, más cabeceras CSP, Permissions-Policy, nosniff y Referrer-Policy. Smoke en Chrome headless sobre la URL pública: la demo recorre atado → rodando → durmiendo → enrollando → atrapado, el mouse ata, Masa carga en `/` y la consola no muestra errores.
- **Webcam real y prueba humana: NO hechas.** La fase 1 queda **pendiente de validación humana**; protocolo para Luis en `docs/yoyo/WEBCAM_VALIDATION.md`.

## Webcam real — primer replay de Luis (2026-10-01, preset sentado)

**Webcam real + humano (Luis).** El tracking de manos funciona bien según Luis, pero el yoyó casi nunca baja. En el replay (`tests/fixtures/yoyo/luis-2026-10-01-seated-throws.json`, 30 s, 756 cuadros) el clasificador en vivo tomó 2 lanzamientos y 1 tirón, y sobre las 19 bajadas etiquetadas a mano la evaluación da **recall de lanzar 1/19 (5,3 %)**.

Datos de la cámara real: ~25 fps efectivos (mediana 33,8 ms, p90 67 ms: cuadros salteados mientras la inferencia está ocupada), captura→llegada mediana 45 ms, 67 cuadros sin mano de 756.

Por qué no se detecta:

- **El lanzamiento natural de Luis tiene una preparación grande.** Sube la mano 0,17–0,43 ih a 1–2,7 ih/s, se detiene arriba 30–100 ms y baja a 1,3–7 ih/s. El clasificador aceptaba sólo una preparación chica (≤ 0,084 ih sentado, ≤ 0,12 de pie) o quietud previa. El corpus sintético usaba preparaciones de 0,02–0,1 ih y no representaba este gesto.
- **Las bajadas más rápidas se desenfocan.** MediaPipe pierde la mano 1–2 cuadros y la reencuentra ~0,3 ih más abajo. Esa ausencia reiniciaba la historia del clasificador y la muestra siguiente quedaba marcada como discontinua por superar 5 ih/s.
- La preparación hacia arriba dispara un tirón si el yoyó está durmiendo. Es coherente con la física (subir la mano de golpe es un tirón).

### Ajuste con el replay real y nueva publicación (2026-10-01)

- **Replay real** (`tests/fixtures/yoyo/luis-2026-10-01-seated-throws.json`, sólo lanzar armado). Con la config sentada pasó de 3/19 a **17/19** y de pie de 1/19 a **16/19**, con 1 falso positivo: la mano saliendo por abajo al cortar la grabación. Con las dos intenciones armadas toma 16/19 y aparecen 9 tirones en las preparaciones, físicamente correctos si el yoyó duerme. Los umbrales se ajustaron sobre esta única grabación: es un control de regresión, no una medición independiente.
- **Sintético, semilla fija.** Precisión 100 % en lanzar y tirar, recall de lanzar 96,0 % y de tirar 88,8 %, 0 disparos en no-eventos consistentes y en clips largos; Y-S2 sigue igual (KNOWN GAP). Con 10 semillas los disparos falsos no cambian. En los escenarios del runtime: 63 pasan, 5 gaps conocidos y 0 fallas.
- **`pnpm test`** corre ahora primero la suite de Masa sola (5 archivos, sin contención de CPU) y después la del yoyó (50 archivos): todo verde en 45 s. Antes, corriendo todo en paralelo, un test de física de Masa se pasaba de tiempo, porque tardaba 8,7 s con la CPU ocupada contra 2 s sin ella.
- **e2e acotado** (mouse, demo, ajustes, cámara falsa, bootstrap de Masa y del yoyó): 15 pasan y 1 falla, `yoyo-camera` con `?qa=camera-replay`. El recorrido completo funciona (dos vueltas y la salida por abajo con viñeta, según `data-trail`), pero el test espera ver el modo transitorio `framing` y con el hook los cuadros llegan en ráfaga cuando termina de cargar el modelo, así que el atado ocurre antes del siguiente sondeo. Es un problema de timing del hook o del test, no de la percepción. **Pendiente de arreglar.**
- **Publicación.** Preview `https://masa-web-demo-ivtbpyj74-luis-projects-4c3ecf2c.vercel.app` y producción `dpl_4TMPjfwn1xWLQSX7fCbxRDT9Sfdg` promovida a https://masa-web-demo.vercel.app/yoyo. En el alias público `/yoyo`, `/`, el JS del yoyó, el worker y el modelo responden HTTP 200 anónimo, con SHA-256 igual a `dist` y las cabeceras de seguridad presentes. El smoke en Chrome sobre la URL pública pasa (demo, mouse y Masa, sin errores de consola).

## Webcam real — segundo replay de Luis (2026-10-01, preset sentado)

**Webcam real + humano.** Luis reporta que «el bajar funciona mejor, el subir está un poco raro». Replay de 54 s, 1287 cuadros, ~25 fps efectivos. El clasificador en vivo disparó 7 lanzamientos y 7 tirones, pero hubo huecos de 7 s y 14 s con el yoyó dormido mientras Luis intentaba tirar: sobre 14 intentos etiquetados se detectaron 4. Después del ajuste de umbrales (ver DECISIONS) se detectan **10/14**. En sintético, con la semilla fija, tirar queda en precisión 98,6 % y recall 90 %, y los clips largos en 0; aparece un gap nuevo de 4 tirones en 300 clips casuales (antes 0). El escenario del runtime da 63 pasan, 5 gaps y 0 fallas. Los tests unitarios de Masa y del yoyó están verdes. Por pedido de Luis **no se corrieron e2e** en esta iteración. Producción `dpl_53DRVxz8jpk32odePmW3QoFF8sWz`, tras el preview `https://masa-web-demo-7sovog84b-luis-projects-4c3ecf2c.vercel.app`; en el alias público, `/yoyo`, `/` y el JS del yoyó responden HTTP 200 con SHA-256 igual a `dist`, y el smoke en Chrome pasa sin errores de consola.
