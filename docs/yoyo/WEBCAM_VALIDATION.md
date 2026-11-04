# Yoyó — validación con webcam real y prueba humana (pendiente, para Luis)

Nada de esto se probó todavía con una webcam real ni con una persona. Todo lo aprobado hasta ahora es sintético, cámara falsa o GPU headless (ver `QA_REPORT.md`). La fase 1 **no está completa** hasta que este protocolo se haga y se registre.

Equipo: la Mac de siempre, Chrome estable, la webcam integrada o la que uses normalmente, luz frontal razonable. URL: https://masa-web-demo.vercel.app/yoyo. No grabes ni compartas video ni fotos. Los landmarks sólo se graban si tocás «Grabar landmarks», y sólo salen de tu navegador si tocás «Descargar JSON».

## 0. Antes de empezar (1 min)

- Abrí «Ajustes → Diagnóstico» y anotá: navegador y versión, `fps`, `frameP95Ms`, `inferenceMs`, `captureToArrivalP50Ms`, `pixelRatio`. No anotes seriales ni datos personales.
- Si estás sentado con el antebrazo apoyado, elegí «Sentado» en el encuadre; si estás de pie, «De pie».

## 1. Encuadre y atado (Y-01, Y-14)

1. «Comenzar con cámara» → aceptá el permiso. Aparece un contorno: levantá la mano dentro del contorno y quedate quieto.
2. ¿El yoyó aparece colgando de tu dedo medio en menos de ~1 s, sin texto que lo explique? ¿Se entiende «está en mi dedo»? (sí/no + comentario).
3. Si no ata en 10 s, la página lo ata donde estés; anotá si pasó.
4. Si podés, pedile a alguien que nunca lo vio que lo pruebe sin ayuda: ¿lanza y recupera en ≤ 60 s? (Y-14)

## 2. Lanzar y dormir (Y-02, Y-03)

1. Mano quieta un momento y lanzá con un movimiento corto y rápido hacia abajo, como con un yoyó real. Hacelo **10 veces**: ¿cuántos lanzamientos se sienten intencionales y responden? (meta ≥ 8/10).
2. ¿Hubo lanzamientos que no pediste (por ejemplo al reacomodar la mano)? Contalos.
3. Mientras duerme: ¿el zumbido sigue el giro (más agudo/fuerte al principio, se apaga al frenar)? ¿El volumen es cómodo?
4. ¿La bajada se siente demasiado lenta, demasiado rápida o bien? (la banda de giro es una decisión a validar: ver `DECISIONS.md`; en «Avanzado» podés probar «Giro de lanzamiento mínimo/máximo» = 60/120 rad/s, la cifra literal del PRD, y comparar).

## 3. Tirón, retorno y atrapada (Y-04, Y-05)

1. Con el yoyó durmiendo, mano quieta un instante y un tirón corto hacia arriba. **10 veces**: ¿cuántos tirones registran? (meta ≥ 8/10).
2. Dejá el yoyó durmiendo **1 minuto** moviendo la mano con naturalidad (sin tirar): ¿cuántos retornos falsos hubo? (meta ≤ 1 por minuto). Anotá qué estabas haciendo cuando pasó.
3. ¿«Vuelve como un yoyó»? ¿Se siente la atrapada (golpe, sonido)?

## 4. Mano perdida, borde de cuadro, giro agotado (Y-06, Y-07, Y-08)

1. Con el yoyó durmiendo, sacá la mano del cuadro 1–2 s y volvé a entrar: ¿el yoyó queda colgando atenuado sin caerse ni dispararse? ¿Al volver, la cuerda salta o se reengancha suave?
2. Lanzá fuerte de modo que la mano salga por abajo: ¿aparece la viñeta y el consejo «Muy abajo…»? ¿Se juega bien con el encuadre recomendado?
3. Dejá que el giro se agote (o en «Avanzado» apagá «Auto-retorno»): ¿queda claro que hay que tirar para enrollar?

## 5. «Me sigue» y comodidad (Y-10, Y-13)

1. ¿La cuerda y el yoyó siguen tu mano sin sentirse «de goma»? (el pivote va ~36 ms detrás de la mano por diseño, más la latencia de cámara).
2. Jugá **5 minutos** seguidos: ¿dolor o fatiga? Probá también el preset «Sentado». Anotá cuál resultó usable.
3. Diagnóstico al final: `fps`, `frameP95Ms`, `latencyP50Ms`/`latencyP95Ms`, `metrics.handLosses`.

## 6. Privacidad y cierre (Y-12)

1. «Apagar cámara»: ¿se apaga el indicador de cámara del navegador? Recargá: ¿no se reactiva sola?
2. Opcional pero muy útil: en «Ajustes → Avanzado → Grabación», grabá ~1 minuto jugando (lanzamientos, tirones y algunos movimientos casuales), «Detener» y «Descargar JSON». Sólo contiene puntos de la mano y tiempos. Si me lo pasás (o lo copiás a `tests/fixtures/yoyo/`), se vuelve fixture de regresión y medimos precisión/recall reales (`pnpm test:yoyo:replays`). Si querés etiquetar, anotá aproximadamente en qué segundos lanzaste y tiraste.

## Cómo reportar

Para cada punto: aprobado / falló (con una línea de cómo reproducirlo) / no probado. Se registra en `docs/yoyo/QA_REPORT.md` bajo «Webcam real» y «Humano», separado de la evidencia sintética. Con eso se decide el ajuste de umbrales (todos viven en «Ajustes → Avanzado») y si se pasa a la fase 2.
