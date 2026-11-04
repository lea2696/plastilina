# Yoyó — PRD y plan de implementación

**Nombre de trabajo:** Yoyó · **Ubicación:** dentro del repositorio de Masa (`/yoyo`), con migración posible a repositorio propio si la idea convence.
**Versión:** 1.0 · **Fecha:** 1 de octubre de 2026
**Destino:** agente de código con acceso al repositorio, terminal y herramientas de prueba.
**Entrega:** experiencia web ejecutable en `/yoyo` y demo desplegable en Vercel; no solamente documentación ni un prototipo visual.

## 0. Cómo usar este documento

Este PRD reúne las decisiones de producto acordadas con Luis, la investigación previa y las conclusiones de dos revisiones críticas independientes (técnica y de producto/QA). Define valores predeterminados para avanzar sin consultas menores y un plan por fases con verificaciones. El agente implementa, prueba y corrige; no devuelve otro plan como única entrega.

Las cifras son **objetivos iniciales de aceptación y parámetros de partida**, no resultados medidos. Nada de esto se ha validado todavía con una webcam real. Registrar evidencia y límites sin convertir hipótesis en hechos.

**Orden de prioridad:** privacidad y control del usuario → detección confiable de intención (lanzar, tirar) → respuesta inmediata y sensación de lanzamiento → estabilidad → acabado audiovisual → trucos avanzados. No sacrificar los primeros puntos para sumar efectos, partículas o trucos.

**Regla central heredada de Masa:** con webcam monocular, todo umbral que dependa de la profundidad por dedo falla. Los gestos se juzgan en 2D (plano de imagen) y la profundidad se resuelve moviendo el objeto virtual, nunca exigiéndosela al usuario.

**Regla central de esta app:** la fase 1 es un problema de *percepción* (detectar lanzamiento y tirón a 30 fps con ~50 ms de latencia) con una máquina de estados pequeña. Primero se prueba la percepción con replays; después se gana la cuerda física y el render bonito.

Las decisiones explícitas de producto (§1.2) sólo cambian con autorización de Luis. Valores predeterminados y decisiones de implementación pueden ajustarse con justificación en `docs/yoyo/DECISIONS.md`. Las reglas de `AGENTS.md` (privacidad, Vercel, assets, no push) siguen vigentes.

---

## 1. Visión del producto

Una persona abre una página, habilita su webcam y juega con un yoyó virtual atado al dedo medio de una mano. Lo lanza hacia abajo, el yoyó baja girando, "duerme" al final de la cuerda zumbando, y con un tirón vuelve a la mano. La otra mano, más adelante, toca y manipula la cuerda para trucos.

El resultado buscado: «Lanzo, el yoyó duerme y vuelve cuando tiro; se siente como un yoyó y quiero hacerlo otra vez».

**No es** un simulador de competencia, un tutorial de trucos, un juego con puntaje ni realidad aumentada sobre el video.

### 1.1 Usuario y propósito

Experimento personal de Luis, continuación de Masa, para explorar seguimiento de manos con una mecánica más rápida y precisa. Demo abierta por URL. Plataforma inicial: computadora con webcam (Mac de Luis como referencia; no asumir modelo), Chrome estable.

### 1.2 Decisiones acordadas

| Tema | Requisito |
|---|---|
| Ubicación | Mismo repo que Masa, como segunda app en `/yoyo`. Código propio en `src/yoyo/`; reutiliza tracking e interacción compartidos. Preparado para migrar a repo propio (sin dependencias cruzadas con el código de Masa fuera de módulos compartidos). |
| Yoyó | **Responsivo** en la primera entrega (vuelve con un tirón). Arquitectura lista para el modo **no responsivo** (rodamiento, vuelve con bind) sin reescritura. |
| Mano que lanza | La cuerda está atada al dedo medio (anclada de forma estable, ver §4.2). |
| Mano libre | Interactúa con la cuerda en fases posteriores (tocar, pellizcar, bind, rock the baby, trapeze). |
| Render | Se rehace desde cero siguiendo las guías investigadas (§6); no reutilizar el estudio de Masa. |
| Input sin cámara | Modo mouse obligatorio para probar sin webcam. |
| Privacidad | Igual que Masa: cámara y landmarks locales, sin envío ni persistencia por defecto. |
| Infra | Vercel, mismo proyecto dedicado `masa-web-demo` (ruta `/yoyo`). Preview antes de producción. |

### 1.3 Valores predeterminados delegados al agente

Interfaz en español rioplatense, mínima (estilo de la última Masa: objeto centrado, sin textos largos, controles secundarios en "Ajustes"). Tema oscuro por defecto. Selector de color del yoyó (efímero). Sonido activado a volumen moderado tras interacción explícita. Sin música, cuentas, analítica de terceros ni backend.

---

## 2. Alcance y prioridades por fase

### Fase 0 — Spike de percepción y modelo (obligatorio, sin render final)
Módulo headless en TypeScript: clasificadores de intención (lanzar, tirar), modelo reducido del yoyó, drivers de replay y mouse. Replays sintéticos con ruido realista. Herramienta opt-in para que Luis grabe replays reales de sus manos (ver §8.3). Gate: §9 Y-S1..Y-S4.

### Fase 1 — Núcleo jugable (P0)
Atado al dedo, lanzar, dormir (sleeper), tirón y retorno, atrapar. Calibración breve, aviso de borde de cuadro, feedback visual y sonoro, modo mouse con el mismo motor, render nuevo básico. Gate: §9 Y-01..Y-14.

### Fase 2 — Trucos de una mano
Around the world (vuelta completa), walk the dog (rueda en el piso). Requiere piso y swing con giro.

### Fase 3 — Mano libre y cuerda física
Cuerda híbrida (tramo tenso analítico + tramo flojo de partículas XPBD), la mano libre toca y pellizca la cuerda (reutilizar intención de agarre + ayuda de profundidad de Masa), modo no responsivo con bind.

### Fase 4 — Trucos de cuerda
Rock the baby, trapeze. Contacto yoyó–cuerda y cuerda–dedos con fricción.

### Fuera de esta versión
Mano con malla y huesos ("rigged") realista, múltiples yoyós, puntaje/retos, mobile, multijugador, grabación de video.

---

## 3. Recorrido y estados de la experiencia

1. **Inicio:** yoyó centrado sobre fondo oscuro; acciones "Comenzar con cámara", "Probar con mouse", "Ver demo" y una línea de privacidad.
2. **Encuadre (calibración, ~10 s, omitible):** silueta guía en pantalla: "levantá la mano dentro del contorno". Mide escala y rango vertical útil. Opcional: "lanzá una vez" para ajustar umbrales al rango de movimiento del usuario. Preset "sentado, antebrazo apoyado" con menor amplitud y mayor ganancia.
3. **Atado:** cuando la mano está estable ~400 ms dentro del encuadre, el yoyó aparece colgando en un loop corto del dedo medio, con un "snap" visual y un click sonoro. Ningún paso de física antes de este estado.
4. **Juego:** lanzar → baja girando → duerme → tirón → vuelve → atrapar. Repetir.
5. **Estados operativos:** mano perdida (el yoyó se atenúa y queda colgando, no cae ni se dispara), borde de cuadro (viñeta + consejo de inclinar la cámara), giro agotado (cuelga y ofrece "tirá para enrollar"), pausa, error de cámara, WebGL no disponible.

---

## 4. Percepción e input

### 4.1 Base
Reutilizar `src/tracking/` (MediaPipe en worker clásico, 640×480, sin envío de frames) y el contrato `HandFrame`. Reutilizar `HandMapper` sólo como referencia: el yoyó necesita su propio mapeo 2D (§4.3). Timestamps monotónicos en ms. Datos con más de 180 ms no aplican fuerza ni disparan eventos.

### 4.2 Ancla de la cuerda
El dedo medio se curva y se ocluye justo al cerrar la mano: **anclar la física en el MCP del dedo medio (landmark 9) o el centroide de palma estabilizado**, y dibujar la cuerda hasta la punta/segunda falange del medio. El pin se maneja con 1€ más responsivo que en Masa (minCutoff 2–3 Hz, beta bajo) seguido de un resorte críticamente amortiguado (ω_n ≈ 25 rad/s). Extrapolar como máximo un intervalo de tracking (~33 ms) con amortiguación; después mantener posición. Nunca alimentar una restricción rígida con la extrapolación cruda.

### 4.3 Espacio de juego
**2D duro en fase 1:** el yoyó y la cuerda viven en el plano z = 0 (vista frontal, espejada una sola vez). La profundidad monocular no participa de la física ni de los disparos. Coordenadas de detección en "alturas de imagen" (ih); coordenadas de mundo en metros con escala tal que una cuerda de **0,65 m de mundo** permita un sleeper visible dentro del cuadro desde la pose calibrada (escalar velocidades de forma consistente; registrar la decisión).

### 4.4 Clasificadores de intención (no física)
Lanzamiento y tirón se detectan **sobre muestras crudas de 30 fps en espacio de imagen**, con buffer corto, no sobre la tensión de una cuerda simulada ni sobre posiciones suavizadas.
- **Lanzar** (estado `atado`): velocidad vertical hacia abajo ≥ 1,2 ih/s sostenida 2 frames, precedida de mano casi quieta (< 0,1 ih/s durante 250 ms) **o** de una pequeña preparación hacia arriba (wind-up). La fuerza del lanzamiento modula, no determina, el resultado: se **sintetiza un lanzamiento canónico** con ω₀ en [60, 120] rad/s mapeado desde la velocidad pico y acotado a una banda que se sienta bien.
- **Tirón** (estado `durmiendo`): Δy hacia arriba ≥ 0,04 ih en ≤ 3 frames, con mano relativamente quieta ≥ 300 ms antes. Refractario de 400 ms tras cualquier disparo.
- Ruido de tracking (saltos de tamaño/z, inclinaciones) no debe producir disparos: usar sólo x/y de imagen del ancla, rechazar frames con salto discontinuo.
- Todos los umbrales viven en un único objeto de configuración con panel de ajuste en "Ajustes → Avanzado" para iterar con Luis.

### 4.5 Modo mouse
El mouse **maneja el ancla directamente** (no emula landmarks): mantener presionado = mano; arrastre rápido hacia abajo = intención de lanzar; arrastre rápido hacia arriba = tirón. Debe recorrer todos los estados. Es también el harness determinista: un recorrido de mouse guionado es un replay sin ruido de tracking, útil para separar errores de física de errores de percepción.

### 4.6 Mano libre (fase 3)
Pellizcar cerca de la cuerda toma la partícula más cercana (intención de agarre, separación pulgar-dedo ponderada en 2D, ayuda de profundidad que mueve la mano virtual al plano de la cuerda, histéresis de liberación por apertura guardada, como en Masa). Sin pellizco, los dedos son obstáculos con fricción.

---

## 5. Modelo físico

### 5.1 Fase 1: modelo reducido determinista
Péndulo 2D de largo variable: pivote = ancla de la mano; estado = ángulo, velocidad angular del swing, largo expuesto L, giro ω, estado del yoyó. Parámetros de partida: m = 0,06 kg; radio de eje r = 3 mm; radio de cuerpo R = 29 mm; inercia de disco; L_max = 0,65 m de mundo.
- **Bajada (rodando):** dL/dt = ω·r; I·dω/dt = r·T − τ_fricción. Aceleración angular de referencia ≈ 65 rad/s² (medición real de un yoyó, ver fuentes).
- **Fin de cuerda:** transición a `durmiendo` con un pequeño rebote/"snap" (feedback, §6) sin pasar L_max más de 1 mm.
- **Dormir:** ω decae exponencialmente (τ ≈ 3–5 s, fricción capstan del loop + aire + paredes), el yoyó cuelga y oscila con el ancla.
- **Retorno (responsivo):** tirón → `enrollando`: dL/dt = −ω·r con ω reforzado, ascenso acotado a 3 m/s; **atrapar** cuando L < 0,05 m y el yoyó está a < 0,1 m del ancla. Si ω cae bajo ~15 rad/s el yoyó responsivo vuelve solo (auto-retorno).
- **Cuerda floja:** si el ancla se acerca al yoyó más rápido que lo que se enrolla, la cuerda se dibuja como catenaria/curva floja y no transmite tensión.
- Determinista: mismo replay → misma trayectoria (con redondeo). Paso fijo 240 Hz, acumulador con tope de 4 pasos por frame de render (descartar tiempo excedente, nunca espiral).

### 5.2 Preparado para no responsivo
Parámetro `responsiveness` en el modelo: en no responsivo el tirón no dispara retorno; el retorno requiere evento `bind` (loop de cuerda introducido en el eje por la mano libre, fase 3). Interfaces y estados ya presentes desde fase 1 aunque sin implementar el bind.

### 5.3 Fases 2–4
- Piso y-0 con rodadura con giro (walk the dog). Swing de 360° con cuerda tensa (around the world).
- **Cuerda híbrida (fase 3):** tramo tenso analítico; tramo flojo como cadena XPBD de "pasos chicos" (≤ 60 partículas, 8 subpasos, 1 iteración, referencias de Ten Minute Physics). **Nunca agregar o quitar partículas en el eje mientras hay tensión**: el largo enrollado es un escalar oculto; el re-muestreo de partículas ocurre en el extremo del dedo (cursor en el extremo cinemático, como Obi).
- Colisión cuerda–cápsulas de dedos con fricción; contacto yoyó–cuerda (trapeze) y auto-contacto de cuerda (fase 4) con spatial hashing.

---

## 6. Dirección visual, audio y feedback

Sin háptica, el peso se comunica con imagen y sonido. Render nuevo en three.js (WebGL2; WebGPU opcional detrás de detección, no requerido).

- **Cámara:** frontal, espejada, alineada con lo que ve la webcam; lo que hacés y lo que ves coinciden.
- **Yoyó:** material PBR (metal/plástico) con iluminación de entorno generada localmente (sin HDRI externo en runtime); color elegible. **Giro:** franja/streak radial proporcional a ω (no motion blur completo en fase 1). **Anillo de giro** fino alrededor del yoyó como indicador.
- **Cuerda:** tubo con grosor real siguiendo la curva (recta tensa o curva floja); **tinte por tensión**; resaltado al tocarla (fase 3).
- **Mano:** silueta translúcida simple (cápsulas por falange + palma, derivadas de landmarks) con un anillo visible en el dedo medio de la mano que lanza. Se tiñe en contacto/agarre como en Masa. **No** mano con malla y huesos en estas fases (rotaciones de falange inobservables con 21 puntos).
- **Sombra:** sombra de contacto/blob sobre piso o fondo; sombras reales sólo si el presupuesto lo permite.
- **Peso simulado:** leve estiramiento y sobrepaso de la cuerda, pequeño retraso del ancla, "snap" al final de la cuerda, hit-stop ≈ 40 ms y sacudida de cámara mínima (con moderación y respetando `prefers-reduced-motion`).
- **Audio (Web Audio procedural):** whoosh al lanzar (tono/volumen según fuerza), zumbido de rodamiento con tono ∝ ω, "zip" al volver, click/thud al atrapar. Controles de silencio y volumen.
- **UI mínima:** estado como píldora breve, viñeta de borde de cuadro, indicador de calidad de tracking; diagnóstico y panel de umbrales en "Ajustes".

---

## 7. Arquitectura

- Vite multipágina: `index.html` (Masa, sin cambios funcionales) y `yoyo.html` → `/yoyo`. Verificar que `vercel.json`/rewrites y CSP sirvan ambas.
- `src/yoyo/`: `perception/` (clasificadores, buffer, ancla), `sim/` (modelo reducido, máquina de estados, luego cuerda), `render/`, `audio/`, `app/` (motor y estados), `ui/`. Contratos propios en `src/yoyo/contracts.ts`; reutilizar `src/shared/contracts.ts` (`HandFrame`) y `src/tracking/`.
- Si hace falta reutilizar `OneEuroFilter` u otros módulos de `src/interaction/`, importarlos sin modificar su comportamiento para Masa (o moverlos a un módulo compartido con tests de Masa intactos).
- Sin estado React por frame; sin colas sin límite; física en hilo principal con presupuesto, inferencia en su worker.
- Presupuestos: física ≤ 1,5 ms/frame p95; render ≤ 8 ms a 60 Hz en GPU integrada; frame p95 ≤ 16,8 ms; latencia intención→reacción visible ≤ 100 ms medida con timestamps.

---

## 8. Pruebas

### 8.1 Convenciones
Separar siempre en `docs/yoyo/QA_REPORT.md`: sintético, cámara falsa de Chrome, GPU headless, webcam real y prueba humana. No dar por cumplida la fase 1 sólo con evidencia sintética.

### 8.2 Sintético
- Replays `HandFrame` generados: curvas canónicas de lanzamiento/tirón muestreadas a 30 fps con desfase aleatorio, 50 ms de retraso, jitter gaussiano (σ ≈ 0,5% del ancho en x/y, 2% en tamaño de palma), frames perdidos, salida por el borde inferior, y **no-eventos** (saludar, reacomodarse, rascarse la cara, mover la mano en arcos).
- Tests de propiedades: miles de lanzamientos aleatorios; invariantes: sin NaN, L ≤ L_max + 1 mm, yoyó nunca por encima del pivote salvo en around the world, ω monótono en sleeper, determinismo.
- Playwright: modo mouse recorre `atado → rodando → durmiendo → enrollando → atrapado`.

### 8.3 Replays reales (opt-in)
Herramienta en "Ajustes → Avanzado" para que Luis grabe una sesión de landmarks (nunca imágenes) y la **descargue como archivo JSON local** por acción explícita; nada se sube ni se guarda automáticamente. Esos archivos, una vez que Luis los aporte al repo, pasan a ser fixtures de regresión y medición de precisión/recall.

### 8.4 Sólo humano
Sensación de lanzamiento, latencia percibida, comportamiento de MediaPipe con desenfoque a velocidad de lanzamiento, encuadre e iluminación reales, fatiga, comprensión del "atado" sin texto, agrado del zumbido.

---

## 9. Criterios de aceptación

### Fase 0 (spike)
| ID | Escenario | Condición |
|---|---|---|
| Y-S1 | Clasificadores en replays sintéticos con ruido | Precisión ≥ 0,95 y recall ≥ 0,85 para lanzar y tirar; 0 disparos en no-eventos. |
| Y-S2 | Latencia de detección | Detección ≤ 2 frames de tracking después del inicio anotado del gesto. |
| Y-S3 | Estabilidad del modelo | 60 s de sleeper con balanceo de mano: L y ω acotados, sin NaN, L ≤ L_max + 1 mm. |
| Y-S4 | Determinismo | Mismo replay → misma trayectoria (redondeo a 1e-6). |

Si Y-S1 falla con replays reales, no avanzar a render: decidir con Luis entre lanzamiento asistido más permisivo o un gesto alternativo.

### Fase 1
| ID | Escenario | Condición sintética | Condición humana |
|---|---|---|---|
| Y-01 | Atado inicial | Se ata ≤ 1 s después de mano estable, nunca antes; sin pasos de física previos. | Se entiende "está en mi dedo" sin texto. |
| Y-02 | Lanzar | Lanzamiento guionado 1,5–3 m/s dispara en ≤ 2 frames; 0 lanzamientos falsos en 5 s quieto. | ≥ 8/10 lanzamientos se sienten intencionales. |
| Y-03 | Sleeper | Llega a dormir, ω decae según la curva, L ≤ L_max + 1 mm. | El zumbido sigue el giro. |
| Y-04 | Tirón | Flick ≥ 0,8 m/s en ≤ 200 ms dispara retorno en ≤ 100 ms; 0 retornos en 60 s de jitter. | ≥ 8/10 tirones registran; ≤ 1 retorno falso por minuto. |
| Y-05 | Retorno y atrapar | Vuelve a < 3 cm del ancla y se re-ata; sin saltos. | "Vuelve como un yoyó". |
| Y-06 | Mano perdida | Datos > 180 ms no aplican fuerza ni disparan; sin teleport > 5 cm al recuperar; sin NaN. | Recupera tras salir de cuadro de verdad. |
| Y-07 | Borde de cuadro | Mano 0,5 s fuera por abajo: extrapolación acotada, estado mantenido o en pausa; viñeta visible. | Jugable con el encuadre recomendado. |
| Y-08 | Giro agotado | Estado definido (cuelga, ofrece tirar para enrollar). | La recuperación es obvia. |
| Y-09 | Estabilidad | 10 min a 240 Hz sin NaN; error de largo < 2%; paso fijo con tope; sin colas sin límite. | — |
| Y-10 | Rendimiento | Física ≤ 1,5 ms p95; frame p95 ≤ 16,8 ms; latencia intención→render ≤ 100 ms medida. | "Me sigue". |
| Y-11 | Paridad mouse | Y-02..Y-05 por la ruta de puntero llegan a los mismos estados (Playwright). | Usable sin cámara. |
| Y-12 | Privacidad | Sin requests con frames o landmarks; sin persistencia de datos de cámara; grabación sólo por descarga explícita. | — |
| Y-13 | Comodidad | — | Sesión de 5 min sin dolor; preset sentado usable. |
| Y-14 | Primer uso | El flujo llega a "atado" sin intervención. | Alguien nuevo lanza y recupera en ≤ 60 s sin ayuda. |
| Y-15 | Masa intacta | Suites de Masa (`pnpm test`, `test:e2e`) siguen pasando; `/` sin cambios funcionales. | — |

Métricas locales (sin envío; exportables sólo por acción explícita): tiempo al primer lanzamiento, lanzamientos/min, tasa de tirones exitosos y falsos, pérdidas de mano/min.

---

## 10. Plan de implementación

1. **Fase 0:** leer `AGENTS.md`, este PRD, `docs/DECISIONS.md` de Masa (lecciones de percepción). Crear `docs/yoyo/{PROGRESS,DECISIONS,QA_REPORT}.md`. Implementar módulo headless (clasificadores, modelo reducido, generador de replays, driver mouse) con tests (`pnpm test:yoyo`). Herramienta opt-in de grabación. Cumplir Y-S1..Y-S4 en sintético; reportar.
2. **Fase 1:** página `/yoyo`, render nuevo, audio, calibración, estados, modo mouse, panel de umbrales. Cumplir criterios sintéticos Y-01..Y-15; desplegar preview → producción en el proyecto dedicado; dejar la validación humana marcada como pendiente con instrucciones claras para Luis.
3. Fases 2–4 sólo después de feedback de Luis con su webcam.

Scripts nuevos esperados (consultar `package.json` antes de asumir): `test:yoyo`, `test:yoyo:replays`, `benchmark:yoyo`; incluir `/yoyo` en `test:e2e` y `audit:dist`.

---

## 11. Riesgos conocidos

1. 30 fps / 50 ms podrían no alcanzar para lanzamiento y tirón confiables → por eso fase 0 y clasificadores por intención con lanzamiento sintetizado.
2. Falsos tirones por jitter → umbrales en espacio de imagen, quietud previa, refractario, rechazo de saltos.
3. Lanzar hacia abajo saca la mano del cuadro → calibración de encuadre, escala de mundo, viñeta, preset sentado.
4. Falta de peso → feedback audiovisual (§6) y lanzamiento canónico.
5. Acople enrollado/desenrollado con cuerda de partículas → modelo reducido en fase 1; cuerda híbrida con re-muestreo en el dedo en fase 3.
6. Fatiga de brazo → sesiones cortas, preset con antebrazo apoyado.

## 12. Fuentes

- Daniel Beauchamp, demo de yoyó con hand tracking en Quest: https://www.uploadvr.com/new-quest-hand-tracking-demos/
- Ten Minute Physics (Müller), XPBD, cuerdas, colisiones y self-collision en JS: https://matthias-research.github.io/pages/tenMinutePhysics/index.html
- XPBD (Macklin, Müller, Chentanez): https://matthias-research.github.io/pages/publications/XPBD.pdf
- Obi Rope, attachments y largo variable: https://obi.virtualmethodstudio.com/manual/7.0/attachments.html
- Dinámica de un yoyó con giroscopio (≈65 rad/s²): https://arxiv.org/pdf/1903.01343
- Fricciones del sleeper (patente tape-supported sleeper yo-yo): https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/4442625
- Bind y trucos: https://forums.yoyoexpert.com/t/bind-what-is-it/13205 · https://yoyo.fandom.com/wiki/Yo-yo_Tricks
- Filtro 1€ (Casiez et al.): https://www.researchgate.net/publication/254005010
- Lecciones de Masa: `docs/DECISIONS.md`, `docs/QA_REPORT.md` de este repositorio.
