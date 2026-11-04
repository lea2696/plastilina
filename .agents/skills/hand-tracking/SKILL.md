---
name: hand-tracking
description: Implementar y verificar webcam local, MediaPipe, identidad temporal y contacto con fixtures reproducibles.
---
# Cuándo
Cambios en cámara, HandFrame, mapeo, calibración, filtrado, colisionadores o pérdida de manos.
# Entradas y procedimiento
Leer docs/PRD.md secciones 3–4 y contratos de src/shared. Solicitar video explícitamente, sin micrófono. Modelo/WASM fijos en manifest. Capturar frame reciente con timestamp monotónico; máximo una inferencia pendiente, descartar obsoletos. Conservar landmarks originales y filtrados separados; no confundir world landmarks centrados por mano con posiciones compartidas. Aplicar espejo una vez. Asociar identidad por proximidad y lateralidad, con liberación ante ambigüedad. Calibrar volumen de trabajo acotado. Caducar fuerza tras 200 ms y liberar agarre antes de 300 ms. Replays deben entrar por el mismo contrato.
# Comandos/evidencia
pnpm test -- tracking; pnpm test:e2e; pnpm verify. Guardar resultados sintéticos y webcam real por separado en docs/QA_REPORT.md. Diagnóstico muestra edad de frame y pérdida.
# Fallos frecuentes
Usar índice como ID; inventar confianza por articulación; atracción desde el aire; mantener mano fantasma; colas de frames; enviar video/landmarks a red.
