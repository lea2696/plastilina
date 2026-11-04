---
name: clay-simulation
description: Evaluar e implementar física 3D plástica con fixtures, medición independiente de volumen y costo combinado.
---
# Cuándo
Cambiar solver, contacto, superficie, mesa, parámetros de estabilidad o pruebas de física.
# Entradas y procedimiento
Leer PRD 5, 8 y 9.3–9.4. Crear colisionadores guionados de dedo, palmas, agarre, caída y pliegue antes de pulir material. Investigar MPM 3D con fuentes primarias; si es inviable medido, evaluar XPBD volumétrico con plasticidad explícita. Medir deformación residual tras 3 s, levantamiento, penetración ≤0,03D, volumen cerrado/ocupación ≤10%, finitud y costo solver+superficie+render. Limitar acumulador y velocidades; no reset oculto. Documentar decisión y límites.
# Comandos/evidencia
pnpm test:physics; pnpm test:topology (debe detectar cruces persistentes); pnpm benchmark; pnpm verify. Guardar configuración, semilla, hardware y reportes en artifacts/qa y docs/DECISIONS.md.
# Fallos frecuentes
Esfera elástica; suma de masas como volumen visual; interacción solo con escalado global; superficie bonita desconectada; benchmark sin extracción/render; hacer verde bajando umbrales.
